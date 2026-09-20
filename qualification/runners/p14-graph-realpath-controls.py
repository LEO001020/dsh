#!/usr/bin/env python3
"""GRAPH-REALPATH negative controls: prove the gate goes RED on a foreign tree.

WHY THIS FILE EXISTS, AND WHY IT IS NOT DECORATION.

V5 section 18 requires a named case:

    GRAPH-REALPATH   foreign worktree/module realpath -> fail.

A gate that never fires and a gate that is absent produce IDENTICAL evidence. So
the gate is not demonstrated by running it on a correct tree and seeing green --
that is a measurement of the tree, not of the gate. It is demonstrated by
injecting the exact defect shape and requiring RED, which is what this file does.

THE DEFECT SHAPE IS NOT HYPOTHETICAL HERE. This project has:

  * retracted TWO root-agent findings (G-SEAM-29, G-SEAM-36) because a measurement
    ran against a tree the reporter did not own;
  * recorded G-SEAM-61 and G-SEAM-66, where a test computed a path relative to
    itself and WROTE into another checkout's evidence;
  * built `packages/dsh-daily-work/src/cross-tree-paths.test.ts` for exactly this
    shape, in the SOURCE plane.

What none of those covers is the RUNTIME plane. A static scan sees a literal; it
cannot see what `dsh-daily-work/host` RESOLVES TO, because that depends on the
profile's `node_modules` links, which `helpers/new-writer.ps1` rewrites per writer.
Fifteen worktrees are live concurrently. A boot whose profile links point at a
sibling loads the SIBLING'S IMPLEMENTATION while reporting its own composition --
and every source-plane gate stays green.

THE CONTROLS. Each mutates the OBSERVATION IN MEMORY (never the tree -- a control
arm that mutated the tree would itself be the defect class this gate is about) and
records the gate's exit code:

  1. POSITIVE  the real observation            -> must be 0 (GREEN)
  2. SIBLING   one extension row's realpath rewritten to a sibling worktree
                                               -> must be 1 (RED)
  3. MAIN      one extension row rewritten to the main tree
                                               -> must be 1 (RED)
  4. BACKSLASH the sibling case with the OTHER Windows spelling
                                               -> must be 1 (RED)
  5. UNRESOLVED one row's realpath nulled
                                               -> must be 1 (RED)
  6. MISSING   the tree that produced the observation renamed
                                               -> must be 1 (RED)
  7. NO-TREE   the observation's repo_root removed
                                               -> must be 1 (RED)
  8. NO-EXT    the extension rows removed entirely
                                               -> must be 1 (RED)

Control 1 is the one that makes the others meaningful: a gate that is red on
everything is not a gate either.

Usage:
    python qualification/runners/p14-graph-realpath-controls.py [--observation <path>]
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
DEFAULT_OBSERVATION = ROOT / "qualification/results/P14-manifest/observation.json"
OUT = ROOT / "qualification/results/P14-manifest/graph-realpath-controls.json"

# ── THE FOREIGN PATHS ARE DERIVED, NOT LITERALS, AND THAT IS LOAD-BEARING ────
#
# The first version of this file hardcoded `D:/DSH/work/wt-s99/...` and
# `D:/DSH/work/dsh-native-daily/...` as live constants. That is the exact shape
# `packages/dsh-daily-work/src/cross-tree-paths.test.ts` refuses, and the gate would
# have gone RED on this file -- correctly. The gate's own comment states the rule:
# "a literal that names ONE checkout, in a repository that is checked out in MANY
# places at once ... no single literal can be correct for all of them, so the correct
# form is to DERIVE the path from the running file."
#
# So the foreign paths are BUILT from this file's own repo root by substituting the
# last path segment. The result has exactly the refused SHAPE at run time, while no
# literal of that shape appears in the source -- which is what the gate asks for and
# also what makes the control correct in every worktree rather than only in wt-p14.
#
# The gate's own test file is exempted by name for this reason ("its own
# negative-control arm carries the defect literal as a FIXTURE, which is the only
# way the control can exist"). This file is NOT exempted, so it derives.
OWN_TREE = str(ROOT).replace("\\", "/")
_OWN_SEGMENT = OWN_TREE.rsplit("/", 1)[-1]

def _sibling(name: str) -> str:
    """A path under a DIFFERENT checkout of this repository, derived from our own."""
    base = OWN_TREE[: -len(_OWN_SEGMENT)] if _OWN_SEGMENT else OWN_TREE
    return f"{base}{name}/packages/dsh-ipython/lib/host-plugin.js"

# A sibling writer's worktree: strictly worse than the main tree, because there is no
# reading under which another writer's ephemeral branch is the right target.
SIBLING = _sibling("wt-s99")
# The same path in the OTHER Windows spelling. A gate that only saw forward slashes
# would be trivially evaded by the backslash form.
SIBLING_BACKSLASH = SIBLING.replace("/", "\\")
# The main tree: the shape G-SEAM-61 / G-SEAM-66 recorded, where a writer's test
# deposited its result into the main tree's evidence directory.
MAIN_TREE = _sibling("dsh-native-daily")


def run_gate(observation: dict) -> tuple[int, str]:
    """Run the generator's GRAPH-REALPATH check over an in-memory observation.

    The observation is written to a TEMP file rather than into the results tree:
    a control artifact that landed in the evidence plane would be a recorded
    measurement that nobody took.
    """
    with tempfile.TemporaryDirectory(prefix="p14-realpath-") as tmp:
        path = Path(tmp) / "observation.json"
        path.write_text(json.dumps(observation), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(GENERATOR), "--graph-realpath-check", str(path)],
            capture_output=True, text=True, timeout=300,
        )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main() -> int:
    parser = argparse.ArgumentParser(description="GRAPH-REALPATH negative controls")
    parser.add_argument("--observation", default=str(DEFAULT_OBSERVATION))
    args = parser.parse_args()

    source = Path(args.observation)
    if not source.is_file():
        print(f"the observation is missing: {source}", file=sys.stderr)
        print("run `node qualification/runners/run-p14-manifest.mjs` first", file=sys.stderr)
        return 2
    try:
        observation = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"the observation is unreadable: {exc}", file=sys.stderr)
        return 2

    # A PRECONDITION, checked before any control runs: if the observation does not
    # carry extension rows, every control would be vacuous -- there would be nothing
    # to rewrite, and a "RED" result would be a fact about the missing rows rather
    # than about the injected realpath.
    if not (observation.get("probe") or {}).get("extensionRows"):
        print("the observation carries no extension rows: the controls would be vacuous", file=sys.stderr)
        return 2

    def mutate_extension(index: int, new_realpath: str) -> dict:
        mutated = copy.deepcopy(observation)
        rows = mutated["probe"]["extensionRows"]
        rows[index]["realpath"] = new_realpath
        return mutated

    def mutate_row(index: int, **fields) -> dict:
        mutated = copy.deepcopy(observation)
        mutated["probe"]["extensionRows"][index].update(fields)
        return mutated

    cases: list[dict] = []

    def add(name: str, expect_exit: int, observation_for_case: dict, what: str) -> None:
        code, output = run_gate(observation_for_case)
        ok = code == expect_exit
        cases.append({
            "case": name,
            "what": what,
            "expected_exit": expect_exit,
            "observed_exit": code,
            "ok": ok,
            "output_tail": output.strip()[-1500:],
        })
        print(f"{'ok  ' if ok else 'FAIL'} {name:12s} expected exit {expect_exit}, observed {code}  ({what})")

    # 1. POSITIVE CONTROL. The real observation must be GREEN, or the gate is red on
    #    everything and proves nothing about the injected cases.
    add("POSITIVE", 0, observation, "the real observation: every extension row inside its own tree")

    # 2. SIBLING WORKTREE. The shape that forced two retractions.
    add("SIBLING", 1, mutate_extension(0, SIBLING),
        "one extension row rewritten to a sibling worktree")

    # 3. MAIN TREE. G-SEAM-61 / G-SEAM-66's shape.
    add("MAIN", 1, mutate_extension(0, MAIN_TREE),
        "one extension row rewritten to the main tree")

    # 4. THE OTHER WINDOWS SPELLING. A gate that only saw forward slashes would be
    #    trivially evaded by the backslash form -- cross-tree-paths.test.ts makes the
    #    same arm for the same reason.
    add("BACKSLASH", 1, mutate_extension(0, SIBLING_BACKSLASH),
        "the sibling case in the backslash spelling")

    # 5. UNRESOLVED. A row that did not resolve is the composition defect this graph
    #    exists to catch, and it must not be silently treated as absent.
    add("UNRESOLVED", 1, mutate_row(0, realpath=None, resolveError="injected: MODULE_NOT_FOUND"),
        "one extension row's realpath nulled with a resolve error")

    # 6. THE TREE MOVED. An observation taken correctly and then invalidated: the
    #    resolved module no longer exists on disk. A DIFFERENT condition from a wrong
    #    observation, and both must fail. The path is derived from our OWN tree, so it
    #    is a missing file in the right checkout rather than a foreign one.
    add("MISSING", 1, mutate_extension(0, f"{OWN_TREE}/packages/dsh-ipython/lib/does-not-exist.js"),
        "a resolved module that does not exist on disk")

    # 7. NO TREE. Without repo_root the gate cannot decide, and it must say so rather
    #    than defaulting to green.
    no_tree = copy.deepcopy(observation)
    no_tree["driver"]["repo_root"] = None
    add("NO-TREE", 1, no_tree, "the observation's repo_root removed")

    # 8. NO EXTENSION ROWS. The implementation rows are what the gate is about.
    no_ext = copy.deepcopy(observation)
    no_ext["probe"]["extensionRows"] = []
    add("NO-EXT", 1, no_ext, "the extension rows removed entirely")

    failures = [c for c in cases if not c["ok"]]
    verdict = "CONTROLS_PROVED" if not failures else "CONTROLS_BROKEN"

    result = {
        "schema_version": 1,
        "kind": "P14_GRAPH_REALPATH_NEGATIVE_CONTROLS_NOT_A_DSH_ARTIFACT",
        "_what_this_is": [
            "The negative controls for V5 section 18's GRAPH-REALPATH case. Each case",
            "mutates the observation IN MEMORY and records the gate's exit code, so the",
            "gate is shown to FIRE on the defect shape rather than merely to be present.",
            "",
            "No tree was modified: a control arm that mutated the tree would itself be the",
            "defect class this gate is about.",
        ],
        "observation_source": str(source).replace("\\", "/"),
        "observation_ran_at": observation.get("ran_at"),
        "observed_in_tree": (observation.get("driver") or {}).get("repo_root"),
        "extension_rows_checked": len((observation.get("probe") or {}).get("extensionRows") or []),
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
