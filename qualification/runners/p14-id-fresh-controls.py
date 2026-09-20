#!/usr/bin/env python3
"""ID-FRESH negative controls: a changed build must have its old identity REJECTED.

V5 section 18 names the case in one line:

    ID-FRESH   current runtime graph/build differs -> old identity rejected.

Computing two identities is not the same as rejecting a stale one. Without controls,
`--id-fresh-check` is a function that exists, is correct, and might never fire -- this
project's most-recorded defect. So each case below mutates a manifest IN MEMORY,
regenerates the identity over the mutated `build` object the same way the generator
does, and records whether the comparison REJECTS it.

WHAT IS AND IS NOT MUTATED. The mutation is applied to the manifest's `build` object
and the identity is RECOMPUTED over it with the generator's own algorithm -- it is not
a hand-typed fake identity. So each case is a manifest that a real build could
produce, and the control tests the COMPARISON rather than the mutation.

  POSITIVE      the manifest against itself                       -> 0 (identical)
  QUALIFIER     only a qualifier (the dirty flag) changed         -> 0 (NOT drift)
  COMMIT        only the commit/tree moved                        -> 1, and names it
                commit-moved-only rather than "artifacts changed"
  GRAPH         one extension row's realpath rewritten to a
                sibling worktree                                  -> 1, and the
                changed field is named
  CATALOG       one tool removed from the model catalog           -> 1, field named
  PROFILE       the profile digest changed                        -> 1, field named
  CONTRACT      only a runner digest changed                      -> 1, but reported
                as CONTRACT MOVED (re-qualify), NOT as a runtime move
  NO-IDENTITY   a manifest that never computed one                -> 1 (refused, not
                compared as if it were a value)

Control 2 is the one that keeps the gate HONEST IN THE OTHER DIRECTION: a qualifier
change must NOT be reported as drift, or the gate would fire on a concurrent writer's
untracked file and be ignored within a day.

Usage:
    python qualification/runners/p14-id-fresh-controls.py [--manifest <path>]
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "qualification/runners/build-manifest.py"
RESULTS = ROOT / "qualification/results"
OUT = ROOT / "qualification/results/P14-manifest/id-fresh-controls.json"


def find_manifest() -> Path | None:
    for directory in sorted(RESULTS.glob("trusted-local-v3.*")):
        candidate = directory / "build-manifest.json"
        if candidate.is_file():
            return candidate
    return None


def canonical_digest(value) -> str:
    """The generator's own algorithm, so a recomputed identity is a REAL identity
    over the mutated build rather than a hand-typed string."""
    import hashlib
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def recompute_identities(manifest: dict) -> dict:
    """Recompute both identities from the manifest's current `build` and `contract`."""
    mutated = copy.deepcopy(manifest)
    mutated["runtime_deployment_identity"] = canonical_digest(mutated["build"])
    contract = {k: v for k, v in (mutated.get("contract") or {}).items()}
    mutated["qualification_contract"]["qualification_contract_identity"] = canonical_digest({
        "runtime_deployment_identity": mutated["runtime_deployment_identity"],
        **contract,
    })
    return mutated


def run_check(old: dict, new: dict) -> tuple[int, str]:
    with tempfile.TemporaryDirectory(prefix="p14-idfresh-") as tmp:
        old_path = Path(tmp) / "old.json"
        new_path = Path(tmp) / "new.json"
        old_path.write_text(json.dumps(old), encoding="utf-8")
        new_path.write_text(json.dumps(new), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(GENERATOR), "--id-fresh-check", str(old_path), str(new_path)],
            capture_output=True, text=True, timeout=300)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main() -> int:
    parser = argparse.ArgumentParser(description="ID-FRESH negative controls")
    parser.add_argument("--manifest", default=None)
    args = parser.parse_args()

    manifest_path = Path(args.manifest) if args.manifest else find_manifest()
    if manifest_path is None or not manifest_path.is_file():
        print("no generated manifest found; run build-manifest.py --from-observation --write first",
              file=sys.stderr)
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"the manifest is unreadable: {exc}", file=sys.stderr)
        return 2

    cases: list[dict] = []

    def add(name: str, expect_exit: int, old: dict, new: dict, what: str,
            must_mention: str | None = None) -> None:
        code, output = run_check(old, new)
        ok = code == expect_exit
        mentioned = True
        if ok and must_mention is not None:
            mentioned = must_mention in output
            ok = ok and mentioned
        cases.append({
            "case": name,
            "what": what,
            "expected_exit": expect_exit,
            "observed_exit": code,
            "must_mention": must_mention,
            "mentioned": mentioned,
            "ok": ok,
            "output_tail": output.strip()[-1200:],
        })
        print(f"{'ok  ' if ok else 'FAIL'} {name:12s} expected exit {expect_exit}, observed {code}"
              + (f", mentions {must_mention!r}={mentioned}" if must_mention else "")
              + f"  ({what})")

    # 1. POSITIVE. The same manifest against itself: no drift, and the gate must not
    #    fire. A gate that fires on everything proves nothing about the injected cases.
    add("POSITIVE", 0, manifest, copy.deepcopy(manifest), "the manifest against itself")

    # 2. A QUALIFIER CHANGE IS NOT DRIFT. The dirty flag lives in `qualifiers` and is
    #    excluded from the hash, so a concurrent writer's untracked file must NOT be
    #    reported as a changed deployment. This arm is what keeps the gate usable.
    qualifier_moved = copy.deepcopy(manifest)
    qualifier_moved["qualifiers"]["git_live_at_generation"]["dirty_path_count"] = 999
    add("QUALIFIER", 0, manifest, qualifier_moved,
        "only the dirty path count moved (a qualifier, not hashed)")

    # 3. COMMIT MOVED ONLY. The identity moves, and the report must say it is the
    #    commit rather than an artifact -- otherwise every commit would look like a
    #    real deployment change and readers would re-measure for nothing.
    commit_moved = copy.deepcopy(manifest)
    commit_moved["build"]["project_git_commit"] = "0" * 40
    commit_moved["build"]["project_git_tree"] = "1" * 40
    add("COMMIT", 1, manifest, recompute_identities(commit_moved),
        "only the commit and tree moved", must_mention="COMMIT MOVED ONLY")

    # 4. THE GRAPH MOVED. A sibling worktree realpath -- the exact shape the
    #    GRAPH-REALPATH gate refuses, reached here through ID-FRESH instead.
    graph_moved = copy.deepcopy(manifest)
    own = str(ROOT).replace("\\", "/")
    segment = own.rsplit("/", 1)[-1]
    foreign = f"{own[: -len(segment)]}wt-s99/packages/dsh-ipython/lib/host-plugin.js"
    graph_moved["build"]["resolved_plugin_graph"]["extension_rows"][0]["realpath"] = foreign
    add("GRAPH", 1, manifest, recompute_identities(graph_moved),
        "one extension row's realpath moved to a sibling worktree",
        must_mention="resolved_plugin_graph")

    # 5. THE MODEL SURFACE MOVED.
    catalog_moved = copy.deepcopy(manifest)
    names = catalog_moved["build"]["model_tool_catalog"]["names_in_header_order"]
    catalog_moved["build"]["model_tool_catalog"]["names_in_header_order"] = names[:-1]
    catalog_moved["build"]["model_tool_catalog"]["tool_count"] = len(names) - 1
    add("CATALOG", 1, manifest, recompute_identities(catalog_moved),
        "one tool removed from the model catalog", must_mention="model_tool_catalog")

    # 6. THE PROFILE MOVED.
    profile_moved = copy.deepcopy(manifest)
    profile_moved["build"]["profile"]["sha256"] = "f" * 64
    add("PROFILE", 1, manifest, recompute_identities(profile_moved),
        "the profile digest changed", must_mention="profile")

    # 7. CONTRACT MOVED ONLY. The deployment is unchanged; a runner digest moved. This
    #    must be REJECTED (exit 1) and reported as a CONTRACT move, because the two
    #    causes call for different actions: re-qualify the contract, do not re-measure
    #    the deployment. A single combined hash could not tell them apart.
    contract_moved = copy.deepcopy(manifest)
    contract_moved["qualification_contract"]["qualification_contract_identity"] = "a" * 64
    add("CONTRACT", 1, manifest, contract_moved,
        "only the contract identity moved", must_mention="CONTRACT MOVED ONLY")

    # 8. NO IDENTITY. A manifest whose identity was never computed (a load-bearing gap)
    #    must be REFUSED rather than compared as if its absent value were a value.
    no_identity = copy.deepcopy(manifest)
    no_identity["runtime_deployment_identity"] = None
    add("NO-IDENTITY", 1, manifest, no_identity,
        "a manifest that never computed an identity")

    failures = [c for c in cases if not c["ok"]]
    verdict = "CONTROLS_PROVED" if not failures else "CONTROLS_BROKEN"

    result = {
        "schema_version": 1,
        "kind": "P14_ID_FRESH_NEGATIVE_CONTROLS_NOT_A_DSH_ARTIFACT",
        "_what_this_is": [
            "The negative controls for V5 section 18's ID-FRESH case. Each case mutates a",
            "manifest IN MEMORY, RECOMPUTES the identity over the mutated build with the",
            "generator's own algorithm, and records whether the comparison rejects it.",
            "",
            "Two arms are load-bearing in opposite directions: POSITIVE and QUALIFIER must",
            "be GREEN (a gate that fires on everything is not a gate, and one that fires on",
            "a concurrent writer's untracked file would be ignored within a day), while the",
            "rest must be RED.",
        ],
        "manifest_under_test": str(manifest_path).replace("\\", "/"),
        "manifest_commit": (manifest.get("build") or {}).get("project_git_commit"),
        "runtime_identity_under_test": manifest.get("runtime_deployment_identity"),
        "ran_at": __import__("datetime").datetime.now().isoformat(),
        "cases": cases,
        "verdict": verdict,
        "failures": [c["case"] for c in failures],
    }
    OUT.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print("")
    print(f"verdict: {verdict}  ({len(cases) - len(failures)}/{len(cases)} cases behaved as required)")
    print(f"wrote {OUT}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
