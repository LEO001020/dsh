#!/usr/bin/env python3
"""META-FLAKY: prove the FLAKY verdict cannot be erased by a green rerun.

WHY THIS IS A META-TEST AND NOT A UNIT TEST. The property under test is not "does
`stability_of` return the string FLAKY". It is "can a person who wants a green
release make the instability disappear from the record by rerunning the case".
That is a question about the RECORD's structure, and the only way to answer it is
to actually append green runs to a ledger that already contains a red one and
observe that the verdict does not move.

THE ARMS, and the failure each one rules out:

  A. THE MEASURED SHAPE. 3 PASS + 1 FAIL on one candidate and fixture -> FLAKY,
     and it blocks. This is `r5-restart-epoch.test.ts`'s measured 1-in-4 rate.
     Rules out: FLAKY not being reachable at all, which would make every later arm
     vacuous.

  B. THE NON-ERASURE ARM, which is the whole point. Append 40 more PASS
     observations for the same candidate and fixture. The verdict must STILL be
     FLAKY. Rules out: the naive mutable-status implementation, where a green
     rerun overwrites the red result and the record becomes indistinguishable from
     a case that never failed.

  C. THE FALSE-POSITIVE ARM. Two DIFFERENT candidates, one green and one red, is
     NOT a flake: each candidate's own observations agreed. Rules out: pooling all
     observations regardless of candidate, which reports a flake where there are
     simply two candidates with two results -- a false positive that would train a
     reader to ignore the verdict.

  D. THE SILENCE ARM. A case with no observations is UNOBSERVED, never PASS.
     Rules out: a fresh clone or a case nobody ran reading as green, which is the
     same defect class as `verify-spec --summary` exiting 0.

  E. THE CHEAP-CLEAR ARM. A clear that names the SAME candidate identity is
     refused. Rules out: "clear the flake" as a relabeling operation with no fix
     behind it.

  F. THE HONEST-CLEAR ARM. A clear naming a DIFFERENT new candidate, a causal fix
     and evidence that exists and hashes DOES clear it -- and the original FAIL
     observation is still in the ledger, so the history is not rewritten.
     Rules out: a gate so strict that the only way to fix a flaky case is to
     delete the record, which would make the gate the reason history gets lost.

Exit codes:
    0  every arm held
    1  at least one arm did not hold
    2  the invocation could not run

Usage:
    python qualification/runners/meta-flaky.py
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _load_stability():
    """Import stability.py by path, registering it so @dataclass can resolve."""
    path = ROOT / "qualification" / "runners" / "stability.py"
    spec = importlib.util.spec_from_file_location("stability", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["stability"] = module
    spec.loader.exec_module(module)
    return module


def obs(case, cand, fixture, outcome):
    return {"case_id": case, "candidate_identity": cand, "fixture": fixture,
            "outcome": outcome}


def main() -> int:
    st = _load_stability()
    arms: list[tuple[str, bool, str]] = []

    # --- A. the measured 1-in-4 shape ------------------------------------------
    ledger = {"observations": [
        obs("BR-05", "cand-A", "win-local", "PASS"),
        obs("BR-05", "cand-A", "win-local", "PASS"),
        obs("BR-05", "cand-A", "win-local", "FAIL"),
        obs("BR-05", "cand-A", "win-local", "PASS"),
    ], "clears": []}
    v = st.stability_of("BR-05", ledger)
    arms.append((
        "A 3 PASS + 1 FAIL on one candidate is FLAKY and blocks",
        v.verdict == "FLAKY" and v.blocks_release,
        f"verdict={v.verdict} blocks={v.blocks_release}",
    ))

    # --- B. THE NON-ERASURE ARM -----------------------------------------------
    for _ in range(40):
        ledger["observations"].append(obs("BR-05", "cand-A", "win-local", "PASS"))
    v2 = st.stability_of("BR-05", ledger)
    arms.append((
        "B 40 subsequent GREEN reruns do NOT erase the prior FAIL",
        v2.verdict == "FLAKY" and v2.failures == 1 and v2.passes == 43,
        f"verdict={v2.verdict} pass={v2.passes} fail={v2.failures}",
    ))

    # --- C. the false-positive arm --------------------------------------------
    two = {"observations": [
        obs("X-1", "cand-A", "f", "PASS"),
        obs("X-1", "cand-B", "f", "FAIL"),
    ], "clears": []}
    v3 = st.stability_of("X-1", two)
    arms.append((
        "C two different candidates (one green, one red) is NOT FLAKY",
        v3.verdict == "STABLE_FAIL",
        f"verdict={v3.verdict} (want STABLE_FAIL)",
    ))

    # --- D. the silence arm ---------------------------------------------------
    v4 = st.stability_of("ZZ-9", {"observations": [], "clears": []})
    arms.append((
        "D a case with no observations is UNOBSERVED, never PASS",
        v4.verdict == "UNOBSERVED" and v4.verdict != "STABLE_PASS",
        f"verdict={v4.verdict}",
    ))

    # --- E. the cheap-clear arm -----------------------------------------------
    cheap = {
        "observations": [obs("BR-05", "cand-A", "win-local", "PASS"),
                         obs("BR-05", "cand-A", "win-local", "FAIL")],
        "clears": [{
            "case_id": "BR-05",
            "flaky_candidate_identity": "cand-A",
            "new_candidate_identity": "cand-A",     # SAME candidate: no fix
            "causal_fix": "reran it and it passed",
            "evidence": {"path": "qualification/results/P1-qualification/README.md",
                         "sha256": "0" * 64},
        }],
    }
    ledger_e, problems_e = st.load_ledger.__wrapped__ if False else (None, None)
    # Validate through the same code path the gate uses, on a temp ledger file.
    import json
    import tempfile
    tmp = pathlib.Path(tempfile.mkdtemp()) / "ledger.json"
    tmp.write_text(json.dumps(cheap), encoding="utf-8")
    loaded, problems = st.load_ledger(tmp)
    # A clear naming the same candidate must be REJECTED as malformed, so it never
    # reaches the verdict as a valid clear.
    refused = any("SAME candidate identity" in p for p in problems)
    v5 = st.stability_of("BR-05", {"observations": loaded["observations"],
                                   "clears": loaded["clears"]})
    arms.append((
        "E a clear naming the SAME candidate is refused, so the case stays FLAKY",
        refused and v5.verdict == "FLAKY",
        f"refused={refused} verdict={v5.verdict} problems={len(problems)}",
    ))

    # --- F. the honest-clear arm ----------------------------------------------
    evidence_rel = "qualification/results/P1-qualification/README.md"
    evidence_path = ROOT / evidence_rel
    honest = {
        "observations": [obs("BR-05", "cand-A", "win-local", "PASS"),
                         obs("BR-05", "cand-A", "win-local", "FAIL")],
        "clears": [{
            "case_id": "BR-05",
            "flaky_candidate_identity": "cand-A",
            "new_candidate_identity": "cand-B",     # a DIFFERENT candidate: a fix
            "causal_fix": "the waiter was registered after send; cand-B registers first",
            "evidence": {"path": evidence_rel,
                         "sha256": st.sha256_file(evidence_path) if evidence_path.is_file()
                         else "0" * 64},
        }],
    }
    tmp2 = pathlib.Path(tempfile.mkdtemp()) / "ledger2.json"
    tmp2.write_text(json.dumps(honest), encoding="utf-8")
    loaded2, problems2 = st.load_ledger(tmp2)
    v6 = st.stability_of("BR-05", {"observations": loaded2["observations"],
                                   "clears": loaded2["clears"]})
    # The FAIL observation must still be present: a clear is not a deletion.
    still_recorded = sum(1 for o in loaded2["observations"] if o["outcome"] == "FAIL") == 1
    arms.append((
        "F an honest clear (new candidate + causal fix + hashed evidence) clears it, "
        "and the original FAIL stays in the ledger",
        v6.verdict == "CLEARED" and still_recorded and not problems2,
        f"verdict={v6.verdict} fail_observations_retained={still_recorded} "
        f"problems={problems2}",
    ))

    # --- report ----------------------------------------------------------------
    failures = 0
    print(f"META-FLAKY: {len(arms)} arm(s)")
    for name, held, detail in arms:
        mark = "HELD" if held else "FAILED"
        if not held:
            failures += 1
        print(f"  [{mark}] {name}")
        print(f"          {detail}")
    if failures:
        print(f"META-FLAKY=FAIL {failures} arm(s) did not hold")
        return 1
    print("META-FLAKY=PASS every arm held")
    return 0


if __name__ == "__main__":
    sys.exit(main())
