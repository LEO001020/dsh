#!/usr/bin/env python3
"""Generator refusal controls: every condition that must REFUSE an identity.

WHY THIS FILE EXISTS. The generator's central safety property is that a
**load-bearing gap** or a **problem** sets `identity_computable: false` and emits
**no identity at all** — so a partial manifest cannot be mistaken for a complete
one, and a default can never be substituted to make a hash agree. That property was
exercised twice for real while the generator was being built (a missing
`bridge_client.py`, and a regex that read 74 characters of a 340-line client), but
"it fired twice by accident" is not a control.

A refusal path that is never exercised is indistinguishable from one that cannot
fire. So each case below mutates the stored observation IN MEMORY and requires exit 1.

Usage:
    python qualification/runners/p14-refusal-controls.py [--observation <path>]
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
OUT = ROOT / "qualification/results/P14-manifest/refusal-controls.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="generator refusal controls")
    parser.add_argument("--observation", default=str(DEFAULT_OBSERVATION))
    args = parser.parse_args()

    source = Path(args.observation)
    if not source.is_file():
        print(f"the observation is missing: {source}", file=sys.stderr)
        return 2
    try:
        observation = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"the observation is unreadable: {exc}", file=sys.stderr)
        return 2

    def set_path(obj: dict, path: list[str], value) -> None:
        node = obj
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value

    cases: list[dict] = []

    def add(name: str, what: str, mutate, expect_exit: int = 1) -> None:
        mutated = copy.deepcopy(observation)
        mutate(mutated)
        with tempfile.TemporaryDirectory(prefix="p14-refusal-") as tmp:
            path = Path(tmp) / "observation.json"
            path.write_text(json.dumps(mutated), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(GENERATOR), "--from-observation", str(path)],
                capture_output=True, text=True, timeout=300)
        ok = proc.returncode == expect_exit
        cases.append({
            "case": name,
            "what": what,
            "expected_exit": expect_exit,
            "observed_exit": proc.returncode,
            "ok": ok,
            "output_tail": ((proc.stdout or "") + (proc.stderr or "")).strip()[-1000:],
        })
        print(f"{'ok  ' if ok else 'FAIL'} {name:22s} exit {proc.returncode} (want {expect_exit})  ({what})")

    # The POSITIVE control: the real observation must SUCCEED. Without this, every
    # case below would be satisfied by a generator that refuses everything.
    add("POSITIVE", "the real observation: an identity IS computable", lambda m: None, expect_exit=0)

    # ── the observation's own preconditions ────────────────────────────────
    add("STALE-BUILD", "a built lib/ older than its src/",
        lambda m: set_path(m, ["build_freshness", "dsh-ipython", "libNewerThanSrc"], False))
    add("UNSETTLED-GRAPH", "the loader tree had not settled when read",
        lambda m: set_path(m, ["probe", "graph", "measuredAfterSettle"], False))
    add("EMPTY-CATALOG", "the model tool catalog is empty (a failed Session looks the same)",
        lambda m: set_path(m, ["probe", "catalog", "toolCount"], 0))
    add("FAILED-VERDICT", "the observation failed its own driver checks",
        lambda m: set_path(m, ["verdict"], "UNUSABLE"))
    add("NO-REVISION", "the observation does not name the commit it was taken at",
        lambda m: set_path(m, ["revision"], {}))
    add("NO-PROBE", "the observation carries no probe result",
        lambda m: set_path(m, ["probe"], {}))

    # ── the graph and the implementation rows ──────────────────────────────
    add("UNRESOLVED-ROW", "a composition row that did not resolve to a file",
        lambda m: set_path(m, ["probe", "graph", "unresolvedRows"],
                           [{"key": "x", "name": "y", "resolveError": "MODULE_NOT_FOUND"}]))
    add("NO-EXT-ROWS", "no dsh-daily-work/dsh-ipython row, so the implementation is unidentified",
        lambda m: set_path(m, ["probe", "extensionRows"], []))

    # ── the load-bearing gaps ──────────────────────────────────────────────
    #
    # THE EXTRACTION IS TESTED BY CALLING IT, not by a mutation of the observation,
    # and the first version of this file got that wrong. It nulled an extension row's
    # realpath and labelled the case "the bridge Python client could not be
    # extracted" -- but that is a GRAPH-REALPATH condition, not an extraction
    # condition, and the extraction reads `lib/bridge.js` directly rather than going
    # through the rows. The case was MISLABELLED: it passed nothing and proved nothing
    # about the thing it named.
    #
    # So `extract_embedded_client` is imported and called with specs that must fail.
    # That tests the REAL function on the REAL built file, with no tree mutation.
    import importlib.util

    spec = importlib.util.spec_from_file_location("p14_build_manifest", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    extraction_cases = [
        ("EXTRACT-MISSING-FILE",
         "the built file does not exist",
         {"built_file": "packages/dsh-ipython/lib/does-not-exist.js",
          "source_file": "x", "export_name": "PYTHON_CLIENT_SOURCE", "why": "control"}),
        ("EXTRACT-NO-EXPORT",
         "the export is absent from a file that exists",
         {"built_file": "packages/dsh-ipython/lib/bridge.js",
          "source_file": "x", "export_name": "NO_SUCH_EXPORT_NAME", "why": "control"}),
        ("EXTRACT-NOT-A-STRING",
         "the export is not a string",
         {"built_file": "packages/dsh-ipython/lib/bridge.js",
          "source_file": "x", "export_name": "default", "why": "control"}),
    ]
    for name, what, bad_spec in extraction_cases:
        row = module.extract_embedded_client(bad_spec)
        ok = row.get("sha256") is None and row.get("error") is not None
        cases.append({
            "case": name,
            "what": what,
            "expected": "sha256 None AND an error recorded",
            "observed": {"sha256": row.get("sha256"), "error": row.get("error")},
            "ok": ok,
            "output_tail": json.dumps(row)[:600],
        })
        print(f"{'ok  ' if ok else 'FAIL'} {name:22s} sha256={row.get('sha256')!r} error recorded={row.get('error') is not None}  ({what})")

    # And the POSITIVE arm for the same function, or the three above would be
    # satisfied by an extractor that always fails.
    good = module.extract_embedded_client(module.EMBEDDED_PYTHON_CLIENTS["bridge_python_client"])
    good_ok = isinstance(good.get("sha256"), str) and (good.get("chars") or 0) > 500
    cases.append({
        "case": "EXTRACT-POSITIVE",
        "what": "the real spec extracts the real client",
        "expected": "a sha256 and >500 chars",
        "observed": {"sha256": good.get("sha256"), "chars": good.get("chars"), "lines": good.get("lines")},
        "ok": good_ok,
        "output_tail": json.dumps(good)[:600],
    })
    print(f"{'ok  ' if good_ok else 'FAIL'} {'EXTRACT-POSITIVE':22s} chars={good.get('chars')} lines={good.get('lines')}  (the real spec extracts the real client)")

    failures = [c for c in cases if not c["ok"]]
    verdict = "CONTROLS_PROVED" if not failures else "CONTROLS_BROKEN"

    result = {
        "schema_version": 1,
        "kind": "P14_REFUSAL_CONTROLS_NOT_A_DSH_ARTIFACT",
        "_what_this_is": [
            "The controls for the generator's central safety property: a problem or a",
            "load-bearing gap makes identity_computable false and NO identity is emitted,",
            "so a partial manifest cannot be mistaken for a complete one and no default is",
            "ever substituted to make a hash agree.",
            "",
            "The POSITIVE case is what makes the rest meaningful: a generator that refused",
            "everything would satisfy every other case.",
        ],
        "observation_source": str(source).replace("\\", "/"),
        "observation_ran_at": observation.get("ran_at"),
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
