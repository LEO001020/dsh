#!/usr/bin/env python3
"""File the V1 IDENTITY verdicts into the live spec, touching ONLY ID-01..ID-06.

WHY A SCRIPT RATHER THAN SIX HAND EDITS. The spec is a 179 KB JSON document that
nine other agents are editing concurrently. A hand edit can silently reformat a
sibling's case, and a `json.dump` round-trip would rewrite the WHOLE file -- which
is exactly the "editing an oracle after the fact" failure the spec forbids, even
when no oracle text changed. So this script:

  1. loads the file as JSON and asserts the ID cases are the only ones it changes,
  2. re-emits the WHOLE document with the same `indent=2, ensure_ascii=False`
     formatting the file already uses (verified against the existing bytes),
  3. verifies AFTER writing that every non-ID case is byte-identical in its
     canonical form to what it was before, and that no ID case's
     oracle/stimulus/requirement/layer was touched,
  4. recomputes every evidence sha256 from disk and REFUSES to record a digest it
     did not measure.

WHAT IT DOES NOT DO. It does not decide a verdict; the verdicts are arguments
passed in below, each one traceable to a file in `qualification/results/V1-identity/`.

Usage:
    python qualification/results/V1-identity/file-verdicts.py [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SPEC = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
IDENTITY = "0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461"
SLICE = "qualification/results/V1-identity"

# The verdicts, each with the evidence that establishes it. Every path is
# repo-relative and under qualification/results/, as verify-spec.py requires.
VERDICTS: dict[str, dict] = {
    "ID-01": {
        "status": "FAIL",
        "note": (
            "FAIL on the graph clause, PASS on every other clause. The boot was a real built-launcher "
            "boot (launcher sha256 69c49c87… = artifact_sha256; the probe's own argv[1] realpath = "
            "launcher_realpath), the first tool call SUCCEEDED (`read` returned the file's own text, "
            "toolResultIsError false, turnEndReason completed), and the graph was recorded from inside "
            "the host by a loader hook: 724 resolutions, 223 distinct @deepseek-ai/* specifiers, 221 from "
            "BUILT, 0 mixed. The oracle requires EVERY such specifier to resolve under packages\\*\\lib\\ "
            "and ONE does not: @deepseek-ai/dsh-attachment-local/src/store.ts resolves to "
            "D:\\DSH\\src\\dsh-src\\packages\\attachment\\attachment-local\\src\\store.ts, imported by "
            "packages/dsh-daily-work/lib/artifacts.js — the BUILT artifact, so this is the product's path, "
            "not a test's. Node 24 loads the .ts by native type stripping, which is why it worked and went "
            "unnoticed. Characterised: the package's entry (lib/index.js) INLINES its own copy of "
            "lib/types/store.js, so the host holds TWO module instances and the module-scope "
            "`const durableHomes = new Set()` is split between them; the two copies are the SAME REVISION, "
            "measured by erasing types with the TypeScript compiler itself, so the consequence is "
            "duplicated work and split state, NOT divergent behaviour. A built public path exists "
            "(lib/types/store.js); the package simply does not export publishImmutableObjectStream. "
            "CONTROLLED LOCAL ROUTE: the keyless mock adapter was used because "
            "live_provider_budget_authorized is false; the probe inserts no tool row. Rebuilt immediately "
            "before the boot (both packages exit 0, lib newer than src, recorded)."
        ),
        "evidence": [
            ("GATES.md", "Gate row ID-01: the oracle verbatim, the command, the measured result, the build digests, and the two defects found in this driver's own instrument."),
            ("ID-01-run.txt", "The driver transcript and all 23 checks: 22 ok, 1 FAIL (`no @deepseek-ai specifier resolved to a source (.ts) file`). Includes the rebuild exit codes, the lib-vs-src freshness comparison, and portReleased true."),
            ("runs/id01/verdict.json", "The judged artifact: build freshness with digests, the full 223-row classified graph, the probe output, the instrument sha256s, and every check with its observed value."),
            ("runs/id01/graph.jsonl", "The raw 724-line resolution record written from inside the booted host, each line carrying seq, atMs, specifier, url and parentURL."),
            ("ID-01-graph-report.txt", "The graph read back: counts, the SOURCE row, the vendor rows, and the parentURL that proves lib/artifacts.js is the importer."),
            ("ID-01-source-import-characterisation.txt", "The three physical copies of the flagged module, their sha256s, the shared module-scope state, and the fact that the entry bundle declares the function without exporting it."),
            ("ID-01-revision-compare.txt", "The revision question decided by ts.transpileModule: the transpiled body from src/store.ts is identical to the one in lib/types/store.js, so the copies are the SAME REVISION."),
        ],
    },
    "ID-02": {
        "status": "PASS",
        "note": (
            "PASS. The identity recomputes from its inputs (computed = recorded = 0a0996f3…) AND, "
            "separately, recomputes from every file-named input RE-HASHED FROM DISK (same value, "
            "stale = none). Both halves are reported because they prove different things: the first "
            "proves the lock was not edited, the second proves the pins still describe the files on this "
            "machine — the failure T17 measured when host_profile_digest recomputed to a MATCH while "
            "pinning a profile revision that no longer existed. A one-byte change to host_profile_digest "
            "(5b8b… → 0b8b…) produces a different identity. Independent corroboration: "
            "qualification/results/T1-spec/verify-identity.py reports 30/30 in this live tree. "
            "Two defects in this instrument's own input map were found and fixed: it pointed "
            "dependency_lock_sha256 at a lockfile this repo does not have (the pin was correct; the map "
            "was wrong), and it compared the spec pin against the live ledger instead of the frozen "
            "as-authored snapshot the pin names."
        ),
        "evidence": [
            ("GATES.md", "Gate row ID-02 with the exact command and both halves of the arithmetic."),
            ("ID-02-ID-04-identity-rederivation.txt", "Section A (identity over the stored inputs) and section B (identity over inputs re-derived from disk), plus the one-byte-change arm."),
            ("ID-04-verify-identity-live.txt", "The independent verifier, 30/30 checks passed in the live tree, including that the identity recomputes and that every case id is unique."),
        ],
    },
    "ID-03": {
        "status": "PASS",
        "note": (
            "PASS on the operative clause. Three comparisons plus an identity check, all measured: 0 of "
            "36 old evidence paths reappear in this file; 0 shared ids with old gates.json; 0 evidence "
            "entries filed under a foreign identity; and 0 inherited verdicts — no non-NOT_RUN shared id "
            "lacks its own local evidence, and no NOT_RUN shared id carries evidence. "
            "IMPORTANT READING NOTE, because the oracle has two clauses and they disagree if taken "
            "literally. Clause A ('zero old case ids appear in this file with any status other than "
            "NOT_RUN') is recorded as a FACT and is NOT the decision: enforced literally it would make 38 "
            "of this spec's own cases unpassable, including VER-01, whose oracle REQUIRES a zero-test run "
            "to be measured. Clause B ('a PASS that arrives without its own evidence file under this "
            "identity is NOT PASS') is the operative test, and it is the clause that catches inheritance; "
            "the spec's own reading_notes and no_inheritance_rule state it in those terms. Both are "
            "reported so neither is silently dropped. "
            "A CAVEAT a reader needs: the by-requirement-name comparison is NOT decidable as a string "
            "comparison, because the old spec's requirement fields are Chinese ('硬30并发', '零测试') and "
            "this spec's are English — the first version of the check reported 30 'undocumented re-issues' "
            "that were purely the language difference. What IS decided is the documentation: only the VER "
            "family carries a numbering_warning. CAP, IPY, REC and RES therefore share ids with the old "
            "spec WITHOUT any statement that their numbering was carried over unchanged, so a reader "
            "comparing those ids across the two files must not assume it was. Recorded as a caveat, not "
            "smoothed into the PASS."
        ),
        "evidence": [
            ("GATES.md", "Gate row ID-03, the two-clause reading, and the numbering caveat."),
            ("ID-03-no-inheritance.txt", "The four comparisons with their counts, the Clause A offenders listed individually with their own evidence counts, and the per-family numbering documentation."),
        ],
    },
    "ID-04": {
        "status": "PASS",
        "note": (
            "PASS. The pin is an identity input and both detections fire. Before the mutation the stored "
            "pin matches the file and the disk-derived identity matches the recorded identity; with ONE "
            "character changed both go false; the re-derived identity moves to a different value; and the "
            "restore is byte-exact (sha256 asserted). The mutation was applied to the file the pin NAMES — "
            "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json — and restored "
            "in a finally block. "
            "THE STRUCTURAL FACT THIS CASE TURNS ON, recorded because a reader will otherwise see the pin "
            "and the live spec disagree: the pin names a FROZEN as-authored snapshot, not the live spec "
            "file. The live file is ALSO the evidence ledger, so filing a verdict changes its bytes by "
            "design — measured, it moved e5b6a1d2 → 341464bc → c00a6345 → 97c77075 as sibling families "
            "filed evidence while the pin stayed at e5b6a1d2. Comparing the pin to the live file reports "
            "'stale pin' for the spec doing exactly its job. What must hold instead is the property the "
            "spec's own rules demand — no oracle was edited after the fact — and that is measured: "
            "between the frozen snapshot and the live ledger, case ids are identical and the lists of "
            "changed ORACLES, STIMULI and REQUIREMENTS are all EMPTY. The only fields that differ are "
            "status, evidence and note."
        ),
        "evidence": [
            ("GATES.md", "Gate row ID-04 and section 4, including the frozen-vs-live field comparison."),
            ("ID-02-ID-04-identity-rederivation.txt", "The mutation arm with both detections, the byte-exact restore, and the live-ledger relationship showing ORACLES/STIMULI/REQUIREMENTS edited = NONE."),
            ("ID-04-verify-identity-live.txt", "The independent verifier: the frozen snapshot's digest equals the pinned input, and the live ledger has the same case ids."),
        ],
    },
    "ID-05": {
        "status": "FAIL",
        "note": (
            "FAIL on the escape-hatch clause; every other clause PASSES. Clean tree: tsconfig.check.json "
            "exits 0 for BOTH packages. Mutation: one injected type error makes it exit 2 at exactly the "
            "injected line (TS2322), restore byte-exact. CONTROL ARM, which the oracle itself demands: the "
            "SAME injected error compiled under tsconfig.json exits 0 — it MISSES the error, because that "
            "config excludes src/**/*.test.ts — so 'a green run under tsconfig.json alone' is now a "
            "measured contrast rather than a claim in a comment. The mutation is a TYPE error deliberately: "
            "vitest runs pool 'forks' with no type-checking step, so it cannot break a concurrent "
            "sibling's run. Source tree digest pinned before and after the clean compile: identical. "
            "THE FAILURE: the oracle says 'no `any` cast, no `as never`, and no non-null `!` is used to "
            "hide a genuinely undefined value'. `as any` 0 real, `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` "
            "0, but `as never` occurs 475 times — 469 in test files and 6 in one production file "
            "(src/durability-runner.ts:20,21,22,43). The 469 test occurrences are the ctx.plugin() "
            "signature-mismatch idiom (e.g. `await ctx.plugin(storageJsonPlugin as never, { root } as never)`) "
            "and are not hiding a genuinely undefined value, and the 6 production occurrences are in the "
            "M4 process-kill rig, which has no production importer; but the oracle names neither carve-out, "
            "so the literal condition is not met and the case is FAIL rather than argued down. "
            "THE THIRD CLAUSE IS DELIBERATELY NOT DECIDED: whether a given `!` hides a genuinely undefined "
            "value is a judgement about code, not a token match, so the scanner counts and locates all 289 "
            "non-null assertions and claims no verdict on them, and says so in its own output. "
            "Deep imports: the oracle's phrase is 'no private symbol is deep-imported across a package "
            "boundary'; 4 deep cross-package specifiers exist and their targets are DECLARED exports "
            "(the target package's exports map contains './src/*'), so the import path is public even "
            "though the symbol is not re-exported. The substantive half of the same fact is ID-01's finding "
            "that one of those deep imports reaches a .ts file at runtime."
        ),
        "evidence": [
            ("GATES.md", "Gate row ID-05 and section 5, with the four-arm table and the construct counts."),
            ("ID-05-clean-check-daily-work.txt", "The clean compile of packages/dsh-daily-work under tsconfig.check.json: EXIT=0, no diagnostics."),
            ("ID-05-clean-check-ipython.txt", "The clean compile of packages/dsh-ipython under tsconfig.check.json: EXIT=0, no diagnostics."),
            ("ID-05-mutation-arm.txt", "The injected type error under the check config: exit 2, TS2322 at the injected line, restore byte-exact, oracle_established true."),
            ("ID-05-control-arm.txt", "The control arm the oracle names: tsconfig.json exits 0 on the SAME error (it misses it) while tsconfig.check.json exits 2 and catches it, both inside one mutation window."),
            ("ID-05-escape-hatch-scan.txt", "The construct scan with per-file locations and contexts, comments stripped first so a comment explaining a pattern is not counted as one. This file establishes the FAIL."),
            ("ID-05-src-tree-before.txt", "The source tree digest before the clean compile: 79 files, digest a9ef6921…."),
            ("ID-05-src-tree-after-clean.txt", "The same digest after: identical, so the tree did not move under the measurement."),
        ],
    },
    "ID-06": {
        "status": "FAIL",
        "note": (
            "FAIL: HEAD matches, the working tree is NOT clean. `git rev-parse HEAD` = "
            "ddefc45fbc7f8e46dd73185e68295696d1297887, exactly the pinned commit. `git status "
            "--porcelain` in D:\\DSH\\src\\dsh-src returns three entries: ' M "
            "packages/deliverables/workspace-changes/src/index.ts', '?? DSHhomem914/' and '?? "
            "data-artifacts/'. The oracle is unconditional — 'Any tracked modification, any staged change, "
            "or a moved HEAD is NOT PASS' — so this is FAIL. "
            "CHARACTERISED, because the entries differ in kind. (1) The tracked ' M' is a LINE-ENDING "
            "ARTIFACT, not a content change: `git diff --exit-code` returns 0 (no content delta), `git diff "
            "--cached` is empty (nothing staged), and `git hash-object` on the worktree file gives "
            "c05787d9… which EQUALS `git rev-parse HEAD:<path>` — the same blob id. The worktree file is "
            "7251 bytes of pure CRLF; the HEAD blob is 7086 bytes of pure LF; the two are identical after "
            "CRLF→LF (measured in both directions). The checkout's .gitattributes says `* text=auto "
            "eol=lf` while the global core.autocrlf is true, and the file's mtime is 2026-09-19 19:19:47 — "
            "an earlier checkout, not this measurement. `git update-index --refresh` still reports 'needs "
            "update'. (2) `?? DSHhomem914/` is 9 untracked files: a DSH home (profiles/sdk/, "
            "sessions/…m914-sdk…, storages/…) written INSIDE the read-only reference checkout by an M9.14 "
            "measurement. (3) `?? data-artifacts/` is one content-addressed object under objects/15/. "
            "So no tracked CONTENT was modified and HEAD has not moved, but two untracked output "
            "directories pollute the checkout and the tracked entry is a tracked modification as far as "
            "the oracle and git status are concerned. Recorded as FAIL rather than argued down: whether a "
            "line-ending-only difference and untracked output should count as 'unmodified' is a judgement "
            "for the spec's owner, not for the agent that ran the stimulus."
        ),
        "evidence": [
            ("GATES.md", "Gate row ID-06 and section 6, with the per-entry characterisation."),
            ("ID-06-pinned-checkout-state.txt", "The raw stimulus output: both commands verbatim, both oracle fields evaluated, and the full characterisation (diff exits, blob ids, byte counts, CRLF/LF counts, the untracked file list)."),
        ],
    },
}

PROTECTED_FIELDS = ("oracle", "stimulus", "requirement", "layer", "family", "mandatory")


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    original_bytes = SPEC.read_bytes()
    spec = json.loads(original_bytes.decode("utf-8"))
    cases = spec["cases"]

    # ---- guards before touching anything -----------------------------------
    before_by_id = {c["id"]: dict(c) for c in cases}
    id_cases = [c for c in cases if str(c.get("id", "")).startswith("ID-")]
    if sorted(c["id"] for c in id_cases) != sorted(VERDICTS):
        print(f"refusing: the spec's ID cases are {sorted(c['id'] for c in id_cases)} "
              f"but this script files {sorted(VERDICTS)}", file=sys.stderr)
        return 2

    # Every evidence file must exist and its digest is MEASURED here, not typed.
    planned: dict[str, list[dict[str, str]]] = {}
    for case_id, verdict in VERDICTS.items():
        entries = []
        for rel, note in verdict["evidence"]:
            path = REPO_ROOT / SLICE / rel
            if not path.is_file():
                print(f"refusing: {case_id} names a missing evidence file: {SLICE}/{rel}", file=sys.stderr)
                return 2
            entries.append({
                "path": f"{SLICE}/{rel}",
                "sha256": sha256_file(path),
                "identity": IDENTITY,
                "note": note,
            })
        planned[case_id] = entries

    # ---- apply --------------------------------------------------------------
    for case in cases:
        case_id = case["id"]
        if case_id not in VERDICTS:
            continue
        for field in PROTECTED_FIELDS:
            assert case[field] == before_by_id[case_id][field], f"{case_id}.{field} changed"
        case["status"] = VERDICTS[case_id]["status"]
        case["note"] = VERDICTS[case_id]["note"]
        case["evidence"] = planned[case_id]

    # ---- post-conditions, checked BEFORE writing ----------------------------
    for case in cases:
        case_id = case["id"]
        if case_id in VERDICTS:
            continue
        if case != before_by_id[case_id]:
            print(f"refusing: this script altered a non-ID case: {case_id}", file=sys.stderr)
            return 2

    # THE FILE USES CRLF LINE ENDINGS, and `json.dumps` emits LF. A round-trip
    # that ignores this reformats every one of the file's 2541 lines -- measured:
    # the first version reported "original 179370 bytes, re-serialised 176829",
    # a 2541-byte difference that is exactly one byte per line. So the line
    # ending is detected from the original bytes and re-applied, and the
    # stability check below is what proves the round trip is a no-op.
    uses_crlf = original_bytes.count(b"\r\n") > 0
    line_ending = "\r\n" if uses_crlf else "\n"

    def serialise(document: dict) -> bytes:
        text = json.dumps(document, indent=2, ensure_ascii=False)
        if uses_crlf:
            text = text.replace("\n", "\r\n")
        return text.encode("utf-8") + line_ending.encode("utf-8")

    new_bytes = serialise(spec)

    # The round-trip must be formatting-stable: re-parsing and re-emitting the
    # ORIGINAL bytes must reproduce the original bytes, or this script would be
    # reformatting the whole document as a side effect of filing six verdicts.
    reserialised_original = serialise(json.loads(original_bytes.decode("utf-8")))
    if reserialised_original != original_bytes:
        print("REFUSING: a JSON round-trip of the ORIGINAL file does not reproduce its bytes, so "
              "writing this file would reformat every case rather than only the six being filed.",
              file=sys.stderr)
        print(f"  original {len(original_bytes)} bytes, re-serialised {len(reserialised_original)} bytes",
              file=sys.stderr)
        return 2

    print("=== filing V1 IDENTITY verdicts ===")
    for case_id in sorted(VERDICTS):
        verdict = VERDICTS[case_id]
        print(f"  {case_id}: {verdict['status']}  ({len(planned[case_id])} evidence entries)")
    print()
    print(f"file: {SPEC}")
    print(f"original bytes : {len(original_bytes)}  sha256 {sha256_file(SPEC)}")
    print(f"new bytes      : {len(new_bytes)}")
    print(f"round-trip stable: True (the original re-serialises to itself)")
    print()
    if args.dry_run:
        print("--dry-run: nothing written.")
        return 0

    SPEC.write_bytes(new_bytes)
    print(f"written. new sha256: {sha256_file(SPEC)}")
    print()
    print("NOTE: the LIVE spec is the evidence ledger, so its digest moves every time a verdict is")
    print("filed. The pinned identity input names the FROZEN as-authored snapshot, which this script")
    print("does not touch. Run `python qualification/runners/verify-spec.py` next.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
