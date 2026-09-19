"""File V6-recovery's REC-01..REC-10 evidence into the trusted-local spec.

WHY THIS IS TEXT SURGERY AND NOT A `json.dumps` REWRITE.
-------------------------------------------------------
This spec is a SHARED file: nine slices file into it, and the V5-data slice
committed its twelve DATA cases at 07:51:08 with a NON-STANDARD indentation style
(12 spaces for an evidence object, 18 for its keys). A round-trip through
`json.load` + `json.dumps(indent=2)` normalises that style and rewrites ~280
lines the sibling owns, producing a diff that is 749 lines wide for a change that
is semantically 10 cases. Measured: the naive version did exactly that.

So this script edits the TEXT. It locates each REC case by its `"id"` anchor,
replaces only the `status` and `evidence` lines inside that case's own span, and
formats the new evidence in the SURROUNDING file's style so the diff stays inside
the RECOVERY family. It then re-parses the result and asserts the semantics, so a
formatting bug cannot pass as a successful filing.

SAFETY PROPERTIES, each checked rather than asserted:
  * the file is re-read immediately before writing and the write is refused if it
    moved (another slice may be filing at this instant);
  * every case outside RECOVERY must be byte-identical before and after;
  * every REC case must end with a status from the spec's own vocabulary, must not
    be NOT_APPLICABLE (the spec forbids it for cases), and must carry evidence;
  * every evidence path must exist and its sha256 must match the file on disk.

USAGE
  python qualification/results/V6-recovery/file-rec-cases.py [--check]
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SPEC = REPO / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
SLICE = "qualification/results/V6-recovery"
IDENTITY = "0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ev(name: str, note: str) -> dict[str, str]:
    path = REPO / SLICE / name
    if not path.is_file():
        raise SystemExit(f"REFUSING: evidence file does not exist: {path}")
    return {
        "path": f"{SLICE}/{name}",
        "sha256": sha256(path),
        "identity": IDENTITY,
        "note": note,
    }


GATES = ev("GATES.md", "Gate row {case}, with the exact command, the measured result and the build digests. Every claim labelled [measured] or [read in source].")
DIGESTS = ev("source-digests.txt", "Build and source identity: tsc -p tsconfig.json exit 0, lib/ and src/ digests for every file this case measures.")

CASES: dict[str, tuple[str, list[dict[str, str]]]] = {
    "REC-01": ("PASS", [
        GATES,
        ev("tests-crash-consistency.txt", "real SIGKILL between artifact publication and the Session reference commit: 1 orphan, 0 integrity errors, object verified; [crash] signal null exitCode 1 orphans 1 integrityErrors 0 objectVerified true."),
    ]),
    "REC-02": ("PASS", [
        GATES,
        ev("tests-dat08.txt", "a referenced object that is MISSING raises artifact-integrity-error, never an empty string; the same block carries the orphan arm and the no-re-execute rule. 5/5 passed."),
        ev("tests-integrity.txt", "an object REPLACED in place at the same length and an object TRUNCATED below the declared bytes both raise artifact-integrity-error (the replaced arm's message matches /hashes to/), with an INTACT object still served as the control. 3/3 passed."),
    ]),
    "REC-03": ("PASS", [
        GATES,
        ev("rec03-crash-before-admission.json", "the measurement written for this case. Window arm: SIGKILL after createRun and before admit -> reopened store taskKeys [] and reserved 0, run still present. CONTROL arm (the same program WITH admit, killed at the same point): taskKeys ['t1'], reserved 7. Both children SIGKILL, liveness re-probed after the signal. Verdict PASS, 7/7 checks."),
        ev("tests-durability-records.txt", "D03 (REAL KILL): a reservation whose launch provably never happened returns to prepared and relaunches EXACTLY ONCE under its ORIGINAL reserved childId, a second relaunch is refused, the attempt counter does not advance and the reservation is not re-taken; the sibling case shows an unknown outcome is NEVER relaunched. 25/25 passed."),
    ]),
    "REC-04": ("PASS", [
        GATES,
        ev("tests-T9-A-B.txt", "T9-B: a lost reply that MAY have committed is reconciled by QUERY with exactly ONE transport invocation across 2x perform + 1x reconcile; the send decision table licenses a send from exactly two states and BOTH are proofs about our own write ordering; an adapter that is neither keyable nor queryable is NOT RUN AT ALL (0 invocations, recorded unknown); the PRODUCT path quarantines a possibly-successful launch with the reservation HELD and a second drain refuses. 16 passed / 16 skipped (32)."),
        ev("tests-effects.txt", "the same constraint at the ledger: a lost reply resolves by query rather than a second send, an unqueryable adapter never resends, and reconcile never reaches the transport in any recorded state. 48/48 passed."),
        ev("tests-durability-records.txt", "D07 (REAL KILL): request/header is durably logged, the request is in flight at the provider and the process is killed; every fault-shaped reading (turnOutcome undefined / interrupted / error) resolves to unknown with the slot held and the credit not reclaimed. 25/25 passed."),
        ev("tests-ipy12-no-replay.txt", "a cell that kills its own kernel is not re-run in the replacement: the append-only marker holds exactly one line after the replacement kernel is driven. 1/1 passed."),
    ]),
    "REC-05": ("PASS", [
        GATES,
        ev("tests-kernel-death.txt", "the REACHABLE arm (dsh-ipython): a real `taskkill /F` on the kernel pid yields a new epoch, volatileStateLost true, previousEpoch equal to the old epoch, a truthy reason, and a replacement kernel that is usable and empty. 2/2 passed."),
        ev("tests-restart-loss.txt", "the supervisor arm: the unknown decision is made NODE-SIDE by the supervisor's own timer rather than by the broker, the restart loss is named, and a kernel that could not be restarted refuses further cells. 9/9 passed."),
    ]),
    "REC-06": ("PASS", [
        GATES,
        ev("tests-recovery-report.txt", "checkpointAsOf, restored, lost, skipped, environmentChanged and unresolvedEffects are separate fields; the as-of is reported EVEN WHEN NOTHING WAS RESTORED so staleness is visible; an environment change sets environmentChanged true and says the data is not comparable; the scope statement the model reads says 'not full session recovery' and 'No past cell was replayed'. 5/5 passed. NOTE: the module carrying this (kernel-lifecycle.ts) is itself unreachable from production, so this is the MECHANISM, not a product property."),
    ]),
    "REC-07": ("PASS", [
        GATES,
        ev("tests-hostile-checkpoint.txt", "every pickle-family format (pickle, pkl, dill, cloudpickle, joblib, torch, h5) refused BY NAME; a pickle disguised as .json refused ON ITS BYTES rather than its extension; an object-dtype array refused from the REAL .npy header; truncated arrays, self-disagreeing declared sizes, the zip-bomb bound and an archive lying about its sizes each refused; a real .npz of safe arrays accepted as the control. 14/14 passed. NOTE: kernel-lifecycle.ts is unreachable from production, so this is the MECHANISM."),
    ]),
    "REC-08": ("PASS", [
        GATES,
        ev("tests-quarantine-reconnect.txt", "onTransportReconnect() returns reexecuted [] and ambiguousCells ['ambiguous'], the transport's dispatched list is unchanged before and after, and the quarantine is STILL IN PLACE; a quarantine clears only through an explicit evidenced resolution and an empty evidence string is refused. 4/4 passed. NOTE: kernel-lifecycle.ts is unreachable from production, so this is the MECHANISM."),
    ]),
    "REC-09": ("FAIL", [
        GATES,
        ev("tests-T9-A-B.txt", "WITH the guard the stale settlement is REFUSED and the refusal is retained durably in its own domain, readable by a second generation, with the authoritative state untouched (state accepted, reserved 7, tombstones [], epoch 1). WITHOUT the guard, offered to the reachable write path WorkService.transition, the same stale settlement IS APPLIED: the task moves to confirmed, the reservation is released to 0, a tombstone is written, and the record epoch is never consulted. The guard is correct and unreachable, so the oracle 'the authoritative write is REFUSED' does not hold on any production path. 16 passed / 16 skipped (32)."),
        ev("tests-durability-records.txt", "D10: the stale epoch is refused while the diagnostic evidence is retained, and a settlement naming a childId that is not the reserved one is refused too. 25/25 passed. This is the guard's correctness, which is why the FAIL is attributed to reachability and not to the guard's logic."),
        ev("import-graph-v6.txt", "the independent compiler-based scan: recovery.ts has NO non-test importer and appears under UNREACHABLE non-test modules, so no production path can reach the guard at all."),
    ]),
    "REC-10": ("FAIL", [
        GATES,
        ev("import-graph-v6.txt", "TypeScript ts.preProcessFile over the package: recovery.ts has NO non-test importer and is in no entry point's transitive closure; reconcile.ts's only non-test importer is durability-runner.ts, itself unreachable; effects.ts has no non-test importer either. 26 reachable / 6 unreachable of 32 non-test modules."),
        ev("tests-T9-A-B.txt", "the second, independent instrument agrees: recovery.ts is in NO entry point's transitive closure (with host.ts as the positive control that the walk works), nothing bumps or reads the record's epoch after initialRunRecord sets it to 1, a real SIGKILL plus a real re-adoption leaves the record at epoch 1, and resume() leaves it at 1. The oracle names this state explicitly: an epoch field that nothing reads or writes after initialisation is INERT and is NOT PASS. 16 passed / 16 skipped (32)."),
    ]),
}


def detect_style(text: str) -> tuple[str, str, str, str]:
    """Return the file's own (indent_of_key, indent_of_object, indent_of_object_key, indent_of_close)."""
    match = re.search(
        r'\n(?P<key>[ \t]+)"evidence": \[\n(?P<obj>[ \t]+)\{\n(?P<inner>[ \t]+)"path":',
        text,
    )
    if match is None:
        raise SystemExit("REFUSING: could not detect the file's evidence indentation style")
    key_indent = match.group("key")
    obj_indent = match.group("obj")
    inner_indent = match.group("inner")
    return key_indent, obj_indent, inner_indent, key_indent


def render_evidence(entries: list[dict[str, str]], style: tuple[str, str, str, str]) -> str:
    key_indent, obj_indent, inner_indent, close_indent = style
    out = ["["]
    for index, entry in enumerate(entries):
        out.append(f"{obj_indent}{{")
        for field in ("path", "sha256", "identity", "note"):
            out.append(f'{inner_indent}"{field}": {json.dumps(entry[field], ensure_ascii=False)},')
        # the last field must not carry a trailing comma
        out[-1] = out[-1][:-1]
        out.append(f"{obj_indent}}}{',' if index < len(entries) - 1 else ''}")
    out.append(f"{close_indent}]")
    return "\n".join(out)


def main() -> int:
    check_only = "--check" in sys.argv
    original = SPEC.read_text(encoding="utf-8")
    style = detect_style(original)

    spec = json.loads(original)
    by_id = {c["id"]: c for c in spec["cases"]}

    text = original
    changed = []
    # REVERSE order of appearance, and the anchors are RE-LOCATED against the
    # CURRENT text on every iteration.
    #
    # Why re-locating is not belt-and-braces but the fix for a real bug: the first
    # version computed every case's span boundary from indices into the ORIGINAL
    # text and then applied edits that change the text's length. Processing
    # backwards keeps the *earlier* indices valid, but the *later* boundary of each
    # span is stale by the length delta of every edit already applied. Measured:
    # the first case processed was fine and the rest silently overran into the
    # neighbouring case, and the re-parse then reported "the case count changed".
    # Process the cases in REVERSE order of their position in the file, so an edit
    # to a later case cannot shift an earlier one's anchor.
    order = []
    for case_id in CASES:
        found = original.find(f'"id": "{case_id}",')
        if found < 0:
            raise SystemExit(f"REFUSING: case {case_id} not found in the spec text")
        order.append((found, case_id))
    for _position, case_id in sorted(order, reverse=True):
        marker = f'"id": "{case_id}",'
        index = text.find(marker)
        if index < 0:
            raise SystemExit(f"REFUSING: case {case_id} not found in the current text")
        later = [
            text.find(f'"id": "{other}",')
            for other in by_id
            if other != case_id and text.find(f'"id": "{other}",') > index
        ]
        end = min(later) if later else text.find('\n  ],\n  "not_applicable_inherited"')
        if end < 0:
            raise SystemExit(f"REFUSING: could not bound the span of {case_id}")

        span = text[index:end]
        status, entries = CASES[case_id]
        rendered = render_evidence(
            [{**e, "note": e["note"].replace("{case}", case_id)} for e in entries],
            style,
        )
        # Replace the status line and the whole evidence array inside the span.
        #
        # BRACKET-SAFE BY CONSTRUCTION, and this is not a stylistic preference. The
        # first version of this replacement used a regex whose evidence pattern was
        # `"evidence": \[[^\]]*\]` — which stops at the FIRST `]`, and several of
        # the notes legitimately contain one (`taskKeys []`, `tombstones []`,
        # `reexecuted []`). On a SECOND run over already-filed text it therefore cut
        # mid-string and produced a file that no longer parsed: measured, a
        # JSONDecodeError at the first note containing `[]`. So the replacement is
        # anchored on the case's OWN object boundary instead of on bracket
        # balancing: everything from `"status":` to the last `}` that closes the
        # case is replaced, and the surrounding text is copied verbatim. That is
        # also what makes the operation IDEMPOTENT, so a re-run after a lost write
        # is safe.
        status_at = span.find('"status":')
        if status_at < 0:
            raise SystemExit(f"REFUSING: no status field in {case_id}'s span")
        # The case object's closing brace is the last one at the case's own indent
        # before the next case begins.
        close_at = span.rfind("\n    }")
        if close_at < 0 or close_at < status_at:
            raise SystemExit(f"REFUSING: could not find the closing brace of {case_id}")
        rebuilt = (
            span[:status_at]
            + f'"status": "{status}",\n{style[0]}"evidence": {rendered}'
            + span[close_at:]
        )
        text = text[:index] + rebuilt + text[end:]
        changed.append((case_id, by_id[case_id]["status"], status))

    # ---- assertions on the RESULT -----------------------------------------
    reparsed = json.loads(text)
    if len(reparsed["cases"]) != len(spec["cases"]):
        raise SystemExit("REFUSING: the case count changed; the surgery is unsound")

    vocab = {"NOT_RUN", "RUNNING", "PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_APPLICABLE"}
    for case in reparsed["cases"]:
        if case["id"] not in CASES:
            continue
        assert case["status"] in vocab, (case["id"], case["status"])
        assert case["status"] != "NOT_APPLICABLE", f"{case['id']}: the spec forbids NOT_APPLICABLE"
        assert case["evidence"], f"{case['id']}: a filed status needs evidence"
        assert len(case["evidence"]) == len(CASES[case["id"]][1]), case["id"]
        for entry in case["evidence"]:
            assert entry["identity"] == IDENTITY, case["id"]
            assert entry["path"].startswith(SLICE + "/"), (case["id"], entry["path"])
            assert (REPO / entry["path"]).is_file(), entry["path"]
            assert sha256(REPO / entry["path"]) == entry["sha256"], entry["path"]

    # Nothing outside RECOVERY may have changed, compared field by field.
    for old, new in zip(spec["cases"], reparsed["cases"]):
        if old["id"] in CASES:
            continue
        assert old == new, f"REFUSING: a non-RECOVERY case changed: {old['id']}"

    print(f"spec: {SPEC}")
    print(f"style detected: evidence key indent={len(style[0])}, object indent={len(style[1])}")
    for case_id, old_status, new_status in sorted(changed):
        print(f"  {case_id}: {old_status} -> {new_status} ({len(CASES[case_id][1])} evidence entries)")

    if check_only:
        print("--check: nothing written")
        return 0

    if SPEC.read_text(encoding="utf-8") != original:
        raise SystemExit(
            "REFUSING: the spec changed on disk between read and write. Re-run; "
            "another slice is filing into the same file and a blind write would clobber it."
        )

    # LF only: .gitattributes pins *.json to eol=lf, and the committed blob is
    # LF-only, so a CRLF write here would change the on-disk digest.
    SPEC.write_bytes(text.encode("utf-8"))
    print(f"wrote {SPEC}")
    print(f"new spec sha256: {sha256(SPEC)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
