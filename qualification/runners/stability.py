"""FLAKY: a release-blocking verdict for a case whose identical runs disagreed.

WHY THIS FILE EXISTS (V5 §4.4). This project measured `r5-restart-epoch.test.ts`
failing at a rate of 1 in 4 -- the same test file, the same candidate, the same
fixture, sometimes green and sometimes red. The three ways a project can react to
that measurement are all wrong:

  * "it passed on the rerun, so it is fine" -- a rerun that goes green after a red
    is not evidence of stability, it is evidence of INSTABILITY, and it was this
    exact sentence that V5 §3 lists as a forbidden inference ("one rerun green =>
    flaky case is stable");
  * "3 of 4 runs passed, so the majority says PASS" -- a majority vote over
    disagreeing runs converts a real defect into a statistical footnote. The
    failure happened; the fact that it happened less often than not does not make
    the product correct;
  * "record FAIL, move on" -- loses the information that the case sometimes
    passes, which is what distinguishes a flaky case from a deterministically
    broken one, and therefore what distinguishes the two fixes.

So the verdict is FLAKY: the candidate BLOCKS, and the verdict is a statement
about a MEASUREMENT rather than about the product.

THE PROPERTY THAT MAKES THIS MORE THAN A LABEL -- a green rerun cannot erase it.

The naive implementation is a mutable status field: a case is FLAKY, someone
reruns it, it passes, someone writes `PASS`, and the instability is gone from the
record. That implementation is indistinguishable from no implementation at all
when it matters, because the person most motivated to rerun is the person who
wants a green release.

This module therefore does not store a status. It DERIVES the verdict from an
APPEND-ONLY observation ledger:

  * every observation is appended, never edited and never removed;
  * FLAKY is computed from the SET of outcomes observed for one
    (case, candidate identity, fixture) triple;
  * adding more PASS observations cannot remove the FAIL observation from the set,
    so the triple stays FLAKY. That is what "future green reruns do not erase the
    prior failure" means STRUCTURALLY rather than as a policy someone must
    remember to follow.

The only way out is a CLEAR entry, and it is deliberately expensive (V5 §4.4:
"only a new candidate with causal fix and new evidence can clear it"). A clear
must name:

  1. the flaky candidate identity it is clearing;
  2. a DIFFERENT new candidate identity -- a fix, so a different artifact. A clear
     that names the same identity is refused, because nothing about the candidate
     changed and therefore nothing about its instability can have been fixed;
  3. the causal fix, in prose, so a reader can ask whether it actually addresses
     the observed failure rather than merely correlating with a green run;
  4. new evidence -- a file that exists and hashes -- so the claim is a
     measurement rather than an assertion.

A clear is not a mutation of history. The FAIL observation stays in the ledger
forever, and a reader can always see that this case once failed at this rate.

WHAT THIS DOES NOT DO. It does not run anything and it does not decide whether a
candidate is correct. It computes a verdict about OBSERVED STABILITY from a ledger
that some runner appended to. If nothing appended, every case is UNOBSERVED, which
is deliberately NOT the same as PASS -- an unobserved case has no stability
verdict, and a release gate must not read silence as green.

Usage:
    from stability import load_ledger, stability_of, flaky_cases
"""
from __future__ import annotations

import hashlib
import json
import pathlib
from dataclasses import dataclass, field

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEDGER = ROOT / "qualification" / "stability-ledger.json"

# The outcomes an observation may record. Deliberately only two: this ledger is
# about whether a case's RESULT is stable, so a third state would blur "it passed",
# "it failed" and "nobody looked".
OBSERVATION_OUTCOMES = {"PASS", "FAIL"}


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@dataclass
class StabilityVerdict:
    """One case's derived stability, plus the observations it was derived from."""

    case_id: str
    verdict: str                     # STABLE_PASS | STABLE_FAIL | FLAKY | UNOBSERVED | CLEARED
    candidate_identity: str | None = None
    fixture: str | None = None
    outcomes: list = field(default_factory=list)     # the raw observed outcomes
    passes: int = 0
    failures: int = 0
    cleared_by: dict | None = None
    problems: list = field(default_factory=list)     # malformed ledger entries
    note: str = ""

    @property
    def blocks_release(self) -> bool:
        """FLAKY blocks. UNOBSERVED blocks nothing BY ITSELF -- it is not a PASS,
        and `release-gate.py` is where "a mandatory case has no verdict" is
        refused. Keeping those two separate is what stops this module from
        becoming a second release policy."""
        return self.verdict == "FLAKY"

    @property
    def stability_line(self) -> str:
        return (f"STABILITY={self.verdict} case={self.case_id} "
                f"runs={len(self.outcomes)} pass={self.passes} fail={self.failures}")


def _group_key(obs: dict) -> tuple:
    return (obs.get("case_id"), obs.get("candidate_identity"), obs.get("fixture"))


def _validate_observation(obs: object, index: int, problems: list) -> bool:
    if not isinstance(obs, dict):
        problems.append(f"observation {index} is not an object: {obs!r}")
        return False
    ok = True
    for key in ("case_id", "candidate_identity", "fixture", "outcome"):
        if not isinstance(obs.get(key), str) or not obs.get(key):
            problems.append(f"observation {index} has no usable {key}: {obs!r}")
            ok = False
    if obs.get("outcome") not in OBSERVATION_OUTCOMES:
        problems.append(
            f"observation {index} outcome {obs.get('outcome')!r} is not one of "
            f"{sorted(OBSERVATION_OUTCOMES)}")
        ok = False
    return ok


def _validate_clear(
    clear: object, index: int, root: pathlib.Path, problems: list,
) -> bool:
    """A clear must be expensive: new candidate, causal fix, and NEW evidence.

    Every one of these four checks exists because omitting it leaves an easy path
    to erasing a flaky record without fixing anything.
    """
    if not isinstance(clear, dict):
        problems.append(f"clear {index} is not an object: {clear!r}")
        return False
    ok = True
    for key in ("case_id", "flaky_candidate_identity", "new_candidate_identity",
                "causal_fix"):
        if not isinstance(clear.get(key), str) or not clear.get(key):
            problems.append(f"clear {index} has no usable {key}")
            ok = False
    # 2. a DIFFERENT candidate. A clear naming the same identity clears nothing:
    #    the artifact is unchanged, so its instability is unchanged.
    if clear.get("flaky_candidate_identity") == clear.get("new_candidate_identity"):
        problems.append(
            f"clear {index} names the SAME candidate identity as both the flaky and "
            "the new one, so nothing changed and nothing is cleared")
        ok = False
    # 4. new evidence that exists and hashes.
    ev = clear.get("evidence")
    if not isinstance(ev, dict):
        problems.append(f"clear {index} carries no evidence object")
        ok = False
    else:
        rel = ev.get("path")
        recorded = ev.get("sha256")
        if not isinstance(rel, str) or not rel:
            problems.append(f"clear {index} evidence has no path")
            ok = False
        else:
            normalized = rel.replace("\\", "/")
            path = root / normalized
            if not path.is_file():
                problems.append(f"clear {index} evidence file does not exist: {rel}")
                ok = False
            else:
                actual = sha256_file(path)
                if not isinstance(recorded, str) or len(recorded) != 64:
                    problems.append(f"clear {index} evidence for {rel} has no usable sha256")
                    ok = False
                elif actual != recorded:
                    problems.append(
                        f"clear {index} evidence {rel} hashes to {actual[:16]}... but "
                        f"the clear records {recorded[:16]}...")
                    ok = False
    return ok


def load_ledger(
    ledger_path: pathlib.Path = LEDGER, root: pathlib.Path = ROOT,
) -> tuple[dict, list[str]]:
    """Read the ledger. Returns (ledger, problems); a missing ledger is EMPTY, not an error.

    An absent ledger means "nothing has been observed", which is a legitimate state
    for a fresh clone and is reported as UNOBSERVED per case rather than as a
    failure of this module.
    """
    if not ledger_path.is_file():
        return {"observations": [], "clears": []}, []
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"observations": [], "clears": []}, [f"the stability ledger is unreadable: {exc}"]
    if not isinstance(ledger, dict):
        return {"observations": [], "clears": []}, ["the stability ledger is not an object"]

    problems: list[str] = []
    observations = ledger.get("observations") or []
    if not isinstance(observations, list):
        problems.append("the stability ledger's `observations` is not a list")
        observations = []
    valid_obs = [o for i, o in enumerate(observations)
                 if _validate_observation(o, i, problems)]

    clears = ledger.get("clears") or []
    if not isinstance(clears, list):
        problems.append("the stability ledger's `clears` is not a list")
        clears = []
    valid_clears = [c for i, c in enumerate(clears)
                    if _validate_clear(c, i, root, problems)]

    return {"observations": valid_obs, "clears": valid_clears}, problems


def stability_of(
    case_id: str,
    ledger: dict,
    candidate_identity: str | None = None,
    fixture: str | None = None,
) -> StabilityVerdict:
    """Derive one case's stability from the append-only ledger.

    FLAKY is computed from the SET of outcomes, so it cannot be erased by adding
    green runs: the red one is still in the set. `candidate_identity`/`fixture`
    narrow the question to one triple when given; when omitted, ALL triples for the
    case are pooled, and any mixed triple makes the case FLAKY. Pooling is the
    stricter reading and is the default on purpose -- a release gate asked about a
    case wants to know about every environment it was run in.
    """
    matching = [
        o for o in ledger.get("observations", [])
        if o.get("case_id") == case_id
        and (candidate_identity is None or o.get("candidate_identity") == candidate_identity)
        and (fixture is None or o.get("fixture") == fixture)
    ]
    outcomes = [o["outcome"] for o in matching]
    passes = outcomes.count("PASS")
    failures = outcomes.count("FAIL")

    if not matching:
        return StabilityVerdict(case_id=case_id, verdict="UNOBSERVED",
                                candidate_identity=candidate_identity, fixture=fixture)

    # The mixed question is asked PER TRIPLE, not over the pooled list. Pooling a
    # PASS on candidate A with a FAIL on candidate B would report a flake where
    # there are simply two different candidates with two different results, and
    # that false positive would train a reader to ignore the verdict.
    triples: dict[tuple, set] = {}
    for obs in matching:
        triples.setdefault(_group_key(obs), set()).add(obs["outcome"])
    mixed = sorted(k for k, v in triples.items() if len(v) > 1)

    if mixed:
        cleared = _find_clear(case_id, ledger, mixed)
        if cleared is not None:
            return StabilityVerdict(
                case_id=case_id, verdict="CLEARED",
                candidate_identity=candidate_identity, fixture=fixture,
                outcomes=outcomes, passes=passes, failures=failures,
                cleared_by=cleared,
                note=(f"was FLAKY on {mixed[0][1][:16]}...; cleared by a new candidate "
                      f"{cleared['new_candidate_identity'][:16]}... with a causal fix"))
        return StabilityVerdict(
            case_id=case_id, verdict="FLAKY",
            candidate_identity=candidate_identity, fixture=fixture,
            outcomes=outcomes, passes=passes, failures=failures,
            note=(f"mixed results on the SAME candidate and fixture "
                  f"({mixed[0][2]}): {sorted(triples[mixed[0]])} "
                  "-- a rerun cannot erase this"))

    if failures and passes:
        # UNREACHABLE AS A MIXED CASE, and deliberately handled as its own state.
        #
        # This branch was originally written as a "kept for safety" fallback that
        # returned FLAKY. It is reachable -- two DIFFERENT candidates, one green and
        # one red, land here -- and returning FLAKY was WRONG: that is not one
        # candidate behaving unstably, it is two candidates with two different
        # results, and calling it a flake would train a reader to ignore the verdict.
        # Measured while writing this file: arm 3 of the stability self-test caught
        # it. The honest verdict for "no single triple is mixed, but failures exist"
        # is STABLE_FAIL: every observation of a given candidate agreed with the
        # others, and at least one candidate failed.
        return StabilityVerdict(case_id=case_id, verdict="STABLE_FAIL",
                                candidate_identity=candidate_identity, fixture=fixture,
                                outcomes=outcomes, passes=passes, failures=failures,
                                note="no single candidate/fixture triple was mixed; "
                                     "a failure exists, so this is not a pass")
    if failures:
        return StabilityVerdict(case_id=case_id, verdict="STABLE_FAIL",
                                candidate_identity=candidate_identity, fixture=fixture,
                                outcomes=outcomes, passes=passes, failures=failures)
    return StabilityVerdict(case_id=case_id, verdict="STABLE_PASS",
                            candidate_identity=candidate_identity, fixture=fixture,
                            outcomes=outcomes, passes=passes, failures=failures)


def _find_clear(case_id: str, ledger: dict, mixed: list) -> dict | None:
    """A clear only applies to the flaky candidate identity it names."""
    flaky_identities = {key[1] for key in mixed}
    for clear in ledger.get("clears", []):
        if clear.get("case_id") != case_id:
            continue
        if clear.get("flaky_candidate_identity") not in flaky_identities:
            continue
        return clear
    return None


def flaky_cases(ledger: dict, case_ids: list[str]) -> list[StabilityVerdict]:
    """Every case in `case_ids` whose stability verdict is FLAKY (uncleared)."""
    verdicts = [stability_of(cid, ledger) for cid in case_ids]
    return [v for v in verdicts if v.verdict == "FLAKY"]


def summarize(ledger: dict, case_ids: list[str]) -> dict:
    """Counts by stability verdict, for a report line."""
    counts: dict[str, int] = {}
    for cid in case_ids:
        v = stability_of(cid, ledger)
        counts[v.verdict] = counts.get(v.verdict, 0) + 1
    return counts
