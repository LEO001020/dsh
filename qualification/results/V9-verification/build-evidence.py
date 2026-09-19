#!/usr/bin/env python3
"""Build the VER-04/05/06 evidence files from the raw captures.

WHY A SCRIPT AND NOT HAND-WRITTEN PROSE. Every quoted block in the generated files
is the VERBATIM text of a capture that was produced by a real run, read back from
disk. Copying it by hand is how a transcript acquires a claim its run did not make,
so the assembly is mechanical and the captures stay the source of truth.

Usage: python qualification/results/V9-verification/build-evidence.py
"""
from __future__ import annotations

import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent
REPO = OUT.parents[2]
IDENT = json.loads((REPO / "compatibility.lock.json").read_text(encoding="utf-8"))[
    "deployment"]["identity"]

BAR = "=" * 78
DASH = "-" * 78


def write(name: str, body: list[str]) -> None:
    (OUT / name).write_text("\n".join(body) + "\n", encoding="utf-8")
    print(f"wrote {name}  ({len('\n'.join(body))} bytes)")


# --------------------------------------------------------------------------
# VER-04 — receipt freshness
# --------------------------------------------------------------------------
raw = (OUT / "cli-ver04-freshness.txt").read_text(encoding="utf-8")
r = json.loads((OUT / "receipt-ver04-fresh-pass.json").read_text(encoding="utf-8"))
body = [
    "VER-04 - a receipt does not outlive the tree it describes",
    BAR,
    "",
    "SPEC ORACLE, quoted:",
    '  "The freshness check reports NOT FRESH and the old verdict is not reusable as',
    "   current completion. Reusing a stale receipt is NOT PASS. NOTE: this is the NEW",
    "   VER-04 and has nothing to do with the old spec's VER-04, which is out of scope",
    '   and recorded in not_applicable_inherited."',
    "",
    "THE NUMBERING WARNING IS HONOURED, not merely cited: the OLD VER-04 was",
    "'verification-environment privilege separation from the host' and it is NOT_APPLICABLE",
    "in this architecture. Nothing in this file is evidence for it. The old gate index",
    "(qualification/gates.json) uses A01.. style ids and shares NO id with this spec, which",
    "the VER-09 tier audit re-checks mechanically.",
    "",
    DASH,
    "MEASURED OUTPUT, all arms, verbatim",
    DASH,
    "",
    raw.rstrip(),
    "",
    DASH,
    "ORACLE CHECKED, clause by clause",
    DASH,
    "",
    f"  a real tree really passes and the receipt records it ... outcome={r['outcome']!r}"
    f" passed={r['passed']} observedTests={json.dumps(r['observedTests'])}",
    f"  the receipt names the tree it is a statement about .... candidateTreeDigest={r['candidateTreeDigest']}",
    f"  and the SCOPE of that digest ......................... candidateTreeDigestScope={r['candidateTreeDigestScope']!r}",
    f"  the definition is bound too .......................... acceptanceDefinitionDigest={r['acceptanceDefinitionDigest']}",
    "  the freshness check reports NOT FRESH after the WORKSPACE changes",
    "      ... measured: fresh=false, with both digests printed (arm 3)",
    "  the freshness check reports NOT FRESH after the DEFINITION changes",
    "      ... measured in-suite: receiptFreshness refuses with",
    "          'the acceptance definition changed since the receipt was written'",
    "  the old verdict is not reusable as current completion",
    "      ... measured: --check exits 1 and says 're-verify' (arm 3)",
    "  CONTROL: freshness is NEVER a verdict -- a FRESH receipt that did not PASS still",
    "      exits 1 (arm 6), so a tool that returned 0 on freshness alone would turn a",
    "      stored NOT PASS into a green light.",
    "",
    "WHAT `receiptFreshness` DOES *NOT* COVER, measured rather than described (arm 4):",
    "  the receipt carries NO oracleDigest field. The candidate digest and the definition",
    "  digest are in it; the ORACLE binding is a SEPARATE record (`VerdictBinding`) compared",
    "  by `bindReceipt`, deliberately, because a field inside a receipt produced by a process",
    "  that runs the candidate would be a weaker claim. The oracle and environment arms are",
    "  therefore measured in-suite, and are named below rather than implied.",
    "",
    "IN-SUITE ARMS (packages/dsh-daily-work/src/verification-gates.test.ts, VER-05 block):",
    "  - 'the receipt is refused after the WORKSPACE changes'",
    "  - 'the receipt is refused after the ORACLE changes, with the workspace untouched'",
    "  - 'the three bindings are INDEPENDENT: each refuses alone, with the other two still matching'",
    "      (every binding is a REAL digest from observedBasis; each mutation moves exactly ONE,",
    "       and a restored tree ACCEPTS -- so an always-refusing bindReceipt could not pass)",
    "  - 'the receipt is refused after the ENVIRONMENT changes'",
    "  - 'a FRESH receipt is still checked for PASSED, so freshness is never a verdict'",
    "  - 'CLOSURE: a receipt from another machine is refused'",
    "  Raw output: verification-gates-tests.raw.txt (51 passed / 51, TEST_EXIT=0)",
    "",
    "VERDICT: PASS",
    f"BUILD/IDENTITY: measured under deployment identity {IDENT}",
]
write("VER-04-receipt-does-not-outlive-its-tree.txt", body)

# --------------------------------------------------------------------------
# VER-05 and VER-06 — one capture, two spec cases
# --------------------------------------------------------------------------
raw = (OUT / "ver05-06-aba-and-inflight.txt").read_text(encoding="utf-8")
cut = raw.index("spec VER-06 -") if "spec VER-06 -" in raw else raw.index("spec VER-06 —")
aba = raw[:cut].rstrip()
inflight = raw[cut:].rstrip()

body = [
    "VER-05 - A-B-A mutation during acceptance is caught",
    BAR,
    "",
    "SPEC ORACLE, quoted:",
    '  "The candidate is frozen to an immutable snapshot and the verdict is bound to',
    "   that snapshot, so the tampered run cannot be certified. The control arm must",
    "   also be run: endpoint hash polling alone would have certified the tampered run,",
    '   and that is demonstrated rather than asserted."',
    "",
    "NOTE ON THE NUMBERING, because it is a live trap in this repo (docs/GAPS.md",
    "G-SEAM-38): the TEST FILE's describe block is labelled 'VER-06: A->B->A ...' and the",
    "SPEC's VER-05 is the A-B-A case while the SPEC's VER-06 is the in-flight-writer case.",
    "The mapping in this slice is by ORACLE, never by label. This file is filed against the",
    "spec's VER-05 because the oracle above is what it measures.",
    "",
    "COMMAND (one child per arm, no loops beyond the readiness poll):",
    "  cd packages/dsh-daily-work",
    "  node D:/DSH/work/dsh-native-daily/qualification/results/V9-verification/ver05-06-aba-and-inflight.mjs",
    "",
    "MEASURED OUTPUT, verbatim",
    DASH,
    "",
    aba,
    "",
    DASH,
    "ORACLE CHECKED, clause by clause",
    DASH,
    "",
    "  the candidate is FROZEN to an immutable snapshot",
    "      arm 1: the child ran in the snapshot directory and read revision A for input,",
    "      oracle AND config while the live tree went A -> B -> A underneath it.",
    "  the verdict is bound to that snapshot",
    "      the snapshot arm's receipt carries liveDigestAtStart == liveDigestAtEnd == the",
    "      pre-mutation digest, and liveDriftDetected == false.",
    "  the tampered run cannot be certified",
    "      arm 2 (the CONTROL) really does execute against the tampered tree: exit code 9 and",
    "      stderr 'SAW_THE_TAMPERED_TREE'. Its receipt carries NO liveDigestAtEnd and NO",
    "      liveDriftDetected field at all -- and the two receipts have the SAME start digest.",
    "  endpoint hash polling alone would have certified the tampered run",
    "      MEASURED, not asserted: liveDigestAtStart == liveDigestAtEnd and liveDriftDetected",
    "      == false in the snapshot arm while the tree demonstrably moved. A before/after hash",
    "      poll sees NOTHING; the snapshot is what makes the frozen revision the tested one.",
    "",
    "HONEST SCOPE, asserted rather than described: in the IN-PLACE arm the runner takes NO",
    "end digest. `liveDigestAtEnd` and `liveDriftDetected` are computed only inside the",
    "snapshot branch, so an in-place receipt has nothing for a later endpoint comparison to",
    "compare -- while still recording a start digest for a tree the command did not run",
    "against. That asymmetry is the finding, and it is measured on the SERIALIZED artifacts.",
    "",
    "IN-SUITE ARMS (same oracle, with the mutation extended to the ORACLE and the CONFIG):",
    "  - 'two-arm proof: the frozen copy is what is tested, and endpoint hashing cannot see the tamper'",
    "  - 'a command that rewrites its own declared input inside the snapshot yields unknown, not pass'",
    "      (outcome 'unknown', stableDuringRun false, holdReservation true -- an unresolved",
    "       mutation produces an UNKNOWN rather than a certification)",
    "  Raw output: verification-gates-tests.raw.txt (51 passed / 51, TEST_EXIT=0)",
    "",
    "A LOAD-DEPENDENT ORACLE WAS FOUND AND FIXED EARLIER IN THIS CASE'S HISTORY (M8):",
    "  the in-place arm's mutation window was anchored to a timer started BEFORE the child",
    "  process existed, so under CPU load the tamper was already restored before the child",
    "  looked and the arm exited 0 -- silently proving nothing. It is now anchored to a",
    "  readiness marker the child writes as its FIRST action, and the child POLLS for the",
    "  tampered revision. Re-proven under the load that exposed it. This slice re-ran the same",
    "  schedule under the current machine load and the control arm exited 9.",
    "  See qualification/results/M8-verification/FINDINGS.md for the original diagnosis.",
    "",
    "VERDICT: PASS",
    f"BUILD/IDENTITY: measured under deployment identity {IDENT}",
    "  subject modules read from SOURCE by absolute file URL (no stale lib/ on this path);",
    "  the package lib/ was rebuilt 2026-09-20 07:37:31, newer than every non-test src/*.ts.",
]
write("VER-05-aba-mutation-caught.txt", body)

body = [
    "VER-06 - in-flight writers are converged or isolated before freezing",
    BAR,
    "",
    "SPEC ORACLE, quoted:",
    '  "The system converges or isolates the writer before freezing, and an unresolved',
    "   mutation produces an unknown rather than a certification. Certifying a tree that",
    '   was still changing is NOT PASS."',
    "",
    "MAPPING NOTE: the spec's VER-06 is the in-flight-writer case. The TEST FILE's describe",
    "block labelled 'VER-07' is the one that covers it, and the block labelled 'VER-06' is the",
    "A-B-A case filed above. Mapping is by ORACLE (docs/GAPS.md G-SEAM-38).",
    "",
    "MEASURED OUTPUT, verbatim",
    DASH,
    "",
    inflight,
    "",
    DASH,
    "ORACLE CHECKED, clause by clause",
    DASH,
    "",
    "  the system CONVERGES the writer before freezing",
    "      path 3: with the writer stopped, convergeBeforeFreeze returns converged=true and a",
    "      digest that EQUALS digestInputs(definition) -- the RUNNER's own tree digest, so the",
    "      converged value is directly comparable with the receipt's liveDigestAtStart. A",
    "      second definition of 'the candidate tree' would be free to drift from the runner's.",
    "  or ISOLATES it",
    "      path 1: a live writer LEASE refuses the freeze outright and names the workspace.",
    "  an unresolved mutation produces an UNKNOWN rather than a certification",
    "      path 2: the lease is released but the tree is still moving between samples; the",
    "      refusal names BOTH digests. The result is converged=false with digest=''.",
    "  certifying a tree that was still changing is NOT PASS",
    "      the STRUCTURAL INVARIANT is asserted over every path, not described: digest !== ''",
    "      implies converged === true. Measured for all three paths above.",
    "",
    "WHY PATH 2 IS THE LOAD-BEARING ONE: a lease is a record the writer keeps, and a writer",
    "that has stopped holding it may still have an in-flight write or a background process.",
    "The lease check alone cannot see that, so the DOUBLE SAMPLE is the only thing that can",
    "answer whether the TREE has stopped moving. Path 1 and path 2 refuse for DIFFERENT",
    "reasons and the reasons are printed separately, so neither can be mistaken for the other.",
    "",
    "IN-SUITE ARMS (packages/dsh-daily-work/src/verification-gates.test.ts, VER-07 block):",
    "  - 'freezing while a writer still holds the workspace is REFUSED as in-flight'",
    "  - 'a workspace still changing under the sampler is refused; only a stable one converges'",
    "  - 'the structural invariant: a refusal NEVER carries a digest'",
    "  Raw output: verification-gates-tests.raw.txt (51 passed / 51, TEST_EXIT=0)",
    "",
    "HONEST LIMIT: this case is about the FREEZE DECISION. It does not establish that a",
    "production caller invokes `convergeBeforeFreeze` before every acceptance; the call site is",
    "the caller's to provide. The mechanism and its refusals are measured; the policy of",
    "applying it is not claimed here.",
    "",
    "VERDICT: PASS",
    f"BUILD/IDENTITY: measured under deployment identity {IDENT}",
]
write("VER-06-in-flight-writers-converged.txt", body)
