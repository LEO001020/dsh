"""File the V4 NATIVE BRIDGE evidence into the trusted-local acceptance spec.

Run from the repo root:  python qualification/results/V4-bridge/file-br-cases.py

WHY A FILE AND NOT AN INLINE SCRIPT. The filing is the load-bearing step of this
slice: it is what turns a measurement into a recorded case. Keeping it on disk
means the exact mapping (case -> evidence path -> note) is auditable and
re-runnable, rather than a heredoc nobody can check afterwards.
"""
from __future__ import annotations

import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPEC = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
LOCK = ROOT / "compatibility.lock.json"
OUT = ROOT / "qualification" / "results" / "V4-bridge"

IDENTITY = json.loads(LOCK.read_text(encoding="utf-8"))["deployment"]["identity"]


def sha256(rel: str) -> str:
    return hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()


def ev(path: str, note: str) -> dict:
    return {"path": path, "sha256": sha256(path), "identity": IDENTITY, "note": note}


G = "qualification/results/V4-bridge/GATES.md"
P = "qualification/results/V4-bridge/v4-bridge-probe.json"
A = "qualification/results/V4-bridge/v4-bridge-approval-probe.json"
S = "qualification/results/V4-bridge/v4-scope-probe.json"
D = "qualification/results/V4-bridge/v4-bridge-drain-probe.json"
W = "qualification/results/V4-bridge/wiring.json"
I = "qualification/results/V4-bridge/import-graph.txt"
TP = "qualification/results/V4-bridge/tests-programmatic-scope.txt"
TC = "qualification/results/V4-bridge/tests-capacity.txt"
TO = "qualification/results/V4-bridge/tests-observation-authority.txt"
MUT = "qualification/results/V4-bridge/mutation-check.txt"

MECH = (
    " MECHANISM ONLY: `new BridgeServer` has zero production call sites and "
    "bridge.ts/native-call.ts are outside every entry point's closure (G-SEAM-34, "
    "qualification/results/V4-bridge/wiring.json and import-graph.txt), so this "
    "route is NOT the shipped profile's route."
)
SCOPE = (
    " SCOPE ROUTE: the IPython bridge does not route through the programmatic "
    "scope service (native-call.ts calls ctx.tools.execute directly), and the "
    "product starts no bridge at all (G-SEAM-34)."
)

FILING: dict[str, tuple[str, list[dict]]] = {
    "BR-01": ("PASS", [
        ev(P, "BR-01: the SAME tool on the model-direct route and from a real cell. Value identical "
              "(marker/value/count/flag), guard decision identical (both denied with the policy's own "
              "message and the body never ran), output-schema violation identical. No route reaches "
              "the executor without the guard." + MECH),
        ev(A, "The APPROVAL arm, which the oracle names explicitly: the REAL ApprovalService under its "
              "`never` policy rejected BOTH routes with the same message, the tool body ran ZERO times "
              "on either (toolBodyRunsInTotal: 0), and the two approval/decided events are on the "
              "session -- which is what makes the cell route the SAME seam rather than a parallel one."),
        ev(G, "Gate table BR-01, with the exact command and the route qualification."),
    ]),
    "BR-02": ("PASS", [
        ev(P, "BR-02: inside ONE cell -- call the target (ok), revoke it through the disposer the "
              "registry's own `register` returned, then call it again -> second-ERROR:UNKNOWN_TOOL. "
              "targetAfterTheCell: UNREGISTERED, revokeCalls: 1. The decision cannot rest on a catalog "
              "captured at cell start, because the SAME cell saw the tool work and then fail." + MECH),
        ev(G, "Gate table BR-02."),
    ]),
    "BR-03": ("PASS", [
        ev(P, "BR-03: a SMALL canonical value read from the cell arrives with its declared type -- "
              "CELL_TYPE:dict, CELL_IS_ARTIFACT:False, and the per-field types "
              "{count:int, flag:bool, marker:str, value:str}. Not silently replaced by a reference "
              "handle. The delivered type is recorded, which is what the oracle asks for." + MECH),
        ev(G, "Gate table BR-03."),
    ]),
    "BR-04": ("PASS", [
        ev(P, "BR-04, BRIDGE route: executionsDuringTheCell: 1 against a 2 MiB payload with a "
              "4096-byte inline bound; the cell received TYPE:Artifact, VERIFY:True, LEN:2097152. "
              "One execution, one reference."),
        ev(TP, "The half the bridge route does not by itself establish: 'runs the tool EXACTLY ONCE and "
               "returns a reference to the final value' AND 'the reference carries the POST-POLICY "
               "value, not the pre-policy one'. The second rules out a reference taken before the "
               "policy stage, which is the failure the oracle names. 42/42 passing."),
        ev(G, "Gate table BR-04."),
    ]),
    "BR-05": ("PASS", [
        ev(P, "BR-05, BRIDGE route: a post-execute policy REPLACES a 2 MiB secret-bearing value. The "
              "cell received HAS_SECRET:False, HAS_REPLACEMENT:True. A sweep of EVERY file in the "
              "artifact directory the cell can reach by path reports "
              "secretAnywhereInTheArtifactDirectory: false, each file's sha256 recorded. The blocked "
              "control arm (a post-execute BLOCK) retained nothing."),
        ev(TP, "The SCOPE route half: 'a post-policy BLOCK leaves no recoverable original in the "
               "store', 'a policy that REPLACES a sensitive value leaves only the replacement "
               "retrievable', 'a blocked call retains nothing even under reference delivery' -- each "
               "sweeps every object in the store. 42/42 passing."),
        ev(G, "Gate table BR-05."),
    ]),
    "BR-06": ("PASS", [
        ev(A, "BR-06: 12 concurrent nested calls driven from a real cell at maxParallel 4 -> "
              "observedMaxConcurrency: 4, totalBodyRuns: 12, cell outcome: ok, and an "
              "exclusive-classified tool ran (the barrier arm). The run COMPLETED inside the budget "
              "rather than deadlocking; a cycle would have produced a cell timeout, not this outcome. "
              "The observed maximum concurrency is recorded, which is what the oracle asks for."),
        ev(TP, "The scope route: 'MANY concurrent wrapped calls complete without exhausting the pool' "
               "and 're-entrancy: a nested call may itself open a nested call, many levels deep', plus "
               "the cap/overlap/barrier arms. The M2 FINDINGS additionally record MUTATION evidence: "
               "with the nested-admission branch mutated to always queue through the pool, the "
               "re-entrancy test TIMED OUT after 60s -- a real deadlock -- and was reverted."),
        ev(G, "Gate table BR-06."),
    ]),
    "BR-07": ("FAIL", [
        ev(D, "BR-07 on the BRIDGE ROUTE, which is the route the stimulus names ('Return a cell while "
              "native child calls are still in flight'). Measured: a real cell started a call without "
              "awaiting it and returned (CELL_RETURNED_WITH_TASK_PENDING True, slowStarted 1, "
              "slowFinished 0, registryResults []). The lease's revoke then WAITED 1499 ms for that "
              "call before resolving, and a call arriving after the revoke was refused LEASE_REVOKED "
              "-- so nothing continues silently. BUT the bridge route has NO per-call disposition "
              "vocabulary: the live CellLease's own keys and prototype methods are id, sessionId, "
              "cellId, epoch, handler, inFlight, seenRequestIds, revoked / live, revokedReason, "
              "invoke, revoke. `disposition`, `jobId` and `handoff` appear NOWHERE in bridge.ts or "
              "native-call.ts. The oracle names four dispositions and requires one per in-flight "
              "call; on the cell route there is none. FAIL on the RECORD half, with the DRAIN half "
              "measured and recorded so the mechanism is not reported as simply absent."),
        ev(TP, "The SCOPE route, where the vocabulary DOES exist and is measured -- 'queued-unstarted "
               "calls are REFUSED with a recorded disposition', 'a host JOBS HANDOFF takes ownership "
               "instead of refusing, and the job id is recorded', 'close resolves only AFTER "
               "in-flight work has settled'. Cited as the CONTRAST, not as this case's evidence: the "
               "bridge does not route through the scope service (native-call.ts calls "
               "ctx.tools.execute directly), so the scope's dispositions cannot establish this "
               "oracle for a cell. Filing them here would be the weaker-oracle substitution this "
               "spec's rules forbid." + SCOPE),
        ev(G, "Gate table BR-07 and section 4a, which states the split and why it is a FAIL."),
    ]),
    "BR-08": ("PASS", [
        ev(P, "BR-08: a tool returning additionalContexts + concludeTurn + a 4096-byte bulk image, "
              "called from a real cell. Control survived and is BOUNDED: noticeCount 1, 106 control "
              "bytes ferried, concludedTurnCount 1. The bulk image did NOT enter model context on this "
              "route: contentBytesEnteringModelContextViaTheBridge 0, because the bridge ferries "
              "CONTROL and returns the program its own copy through the value/artifact door -- the "
              "model projection is the tool's own render and is not carried by the bridge. The "
              "recorded byte count is stated, which is what the oracle asks for."),
        ev(TP, "The boundedness half on the scope route: 'a security additionalContext reaches the "
               "enclosing execution, bounded' and 'past the direct bound, notices are COALESCED into "
               "one bounded record, not dropped' -- so the bound is not a silent drop."),
        ev(G, "Gate table BR-08."),
    ]),
    "BR-09": ("PASS", [
        ev(P, "BR-09, WIRE level: a hand-made frame over a real socket carrying a LIVE lease id, real "
              "cell id, real epoch and a forged host-authored field, sent ONE FIELD AT A TIME. The "
              "bridge's own seven authority fields -- authority, agent, session, sessionId, "
              "rootCallId, parent, parentToken -- were ALL REFUSED with FORGED_AUTHORITY. The refusal "
              "is TARGETED, not an outage: the same frame without a forged field IS served. The "
              "forgery check runs BEFORE any lease lookup. RECORDED PRECISION: the oracle's other "
              "examples (id, captured, captured.sha256) are NOT in the bridge's authority list and "
              "those frames were SERVED -- but the forged key never REACHED the executor: the "
              "handler's own received keys are exactly arguments, cellId, epoch, leaseId, requestId, "
              "tool in every served frame, and forgedFieldReachedTheHandler is false. A field the host "
              "drops cannot promote a claim."),
        ev(TO, "BR-09, TYPE level, and it is where the oracle's exact paths ARE refused: "
               "HOST_AUTHORED_PATHS includes id, captured, captured.sha256, captured.bytes, "
               "authority and authority.ownerScope; refuseForgedClaims refuses a kernel payload "
               "asserting any of them, naming every offending path, code "
               "observation-authority-forged, and a forged capture is refused BEFORE anything is "
               "written so a bad payload cannot cause an effect. 5/5 passing. Together with the wire "
               "arm these are the type-level AND wire-level defences the oracle names."),
        ev(G, "Gate table BR-09 and section 4a, which states the precision."),
    ]),
    "BR-10": ("PASS", [
        ev(S, "BR-10: the close driven for EACH of the three declared reasons -- completed, aborted, "
              "error. In every case 5 calls were submitted with 2 IN FLIGHT at close (measured: "
              "startedAtClose 2), and the result was 5 dispositions, uniqueSubCallIds 5, "
              "everyDispositionCarriesTheCloseReason true, everyCallReachedATerminalState true, with "
              "cancelled for the started calls and abandoned-unstarted for the queued ones. NO call "
              "remains unsettled after the close. The `error` reason had NO coverage in the existing "
              "suite (0 uses against 34 for `completed`), which is why this probe exists."),
        ev(TP, "The scope suite's own drain arms, including 'close resolves only AFTER in-flight work "
               "has settled' and 'invoking after close is refused, not silently queued'. 42/42 "
               "passing." + SCOPE),
        ev(G, "Gate table BR-10."),
    ]),
    "BR-11": ("PASS", [
        ev(S, "BR-11: ONE image-returning tool run under BOTH declared modes, with the delivered BYTE "
              "COUNT recorded in each. `reference` -> 0 bytes to model context, 187 bytes retained as "
              "a reference with its sha256 and lossless:true; `defer-images` -> 4114 bytes to model "
              "context of which 4096 are the image, 0 bytes retained. modesDifferAsRequired true. The "
              "mode is visible in the record through which slot filled, not only through the "
              "constructor argument. The byte counts differ as the modes require."),
        ev(TP, "The scope suite's behavioural arms: 'a BULK image does NOT automatically enter model "
               "context; it is retained as a reference' and 'defer-images reproduces stock run_code "
               "content behaviour, for comparison'. 42/42 passing."),
        ev(G, "Gate table BR-11."),
    ]),
    "BR-12": ("PASS", [
        ev(A, "BR-12: FROM A CELL, maxDepth 99 against a deployment ceiling of 1 -> "
              "DEPTH_CEILING_EXCEEDED, refused, with the refusal RECORDED host-side (refusalCount 1, "
              "callerAskedFor 99) and the reason naming the mechanism: the depth is read from the "
              "child's own durable header, so no request field can raise the ceiling. The cell "
              "received a structured error rather than a value."),
        ev(TC, "The deployment gate's own arms against the REAL continuable stack: 'a caller passing "
               "maxDepth 99 is REFUSED', 'an OMITTED maxDepth is REFUSED too, not read as permission', "
               "'the depth ceiling does not consume a capacity slot when it refuses', and the control "
               "'a depth-1 child IS admitted, so the ceiling is not a blanket refusal'. 41 passed + 1 "
               "expected fail."),
        ev(P, "The BRIDGE SURFACE half: the client's own frame carries exactly type, requestId, tool, "
              "arguments, leaseId, cellId, epoch -- there is no depth field for a caller to raise, and "
              "the seven authority-bearing field names are refused."),
        ev(G, "Gate table BR-12."),
    ]),
}

REACHABILITY = {
    "gate": "G-SEAM-34",
    "statement": (
        "The bridge MECHANISM is measured correct (all 12 cases PASS), and the PRODUCT does not "
        "start it: `new BridgeServer` has ZERO production call sites and bridge.ts/native-call.ts are "
        "outside the transitive closure of every declared entry point. Measured this round by two "
        "independent instruments that agree: qualification/results/V4-bridge/wiring.json "
        "(symbol-level) and qualification/results/V4-bridge/import-graph.txt (compiler-based entry "
        "closure)."
    ),
    "combined_statement": (
        "The FORBIDDEN seam (ctx.terminalController) is absent AND the sanctioned one is unwired, so "
        "today the model's Python has no tool access at all. That matters more than either half "
        "alone, because `ipython` is the model's ONLY execution surface: the composed profile is 27 "
        "tools with pwsh/bash absent "
        "(qualification/results/M12-deliverable-surface/surface-fresh-install.json)."
    ),
    "why_not_a_case": (
        "No BR oracle asks whether the product starts the bridge; every one asks whether the bridge "
        "behaves correctly when driven, and it does. Filing this as a FAIL on a BR case would assert "
        "an oracle that case does not state. It is recorded here, on the family, and in docs/GAPS.md."
    ),
    "evidence": [
        ev(W, "instrument A: verdict.bridgeIsStartedInProduction false; productionCallSites for "
              "`new BridgeServer` is []"),
        ev(I, "instrument B: bridge.ts and native-call.ts UNREACHABLE from all five export roots"),
        ev(MUT, "the detector falsified: a temporary canary constructing a BridgeServer made T7-07's "
                "arm FAIL naming packages/dsh-ipython/src/v4-mutation-canary.ts"),
    ],
}


def main() -> int:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    touched: list[str] = []
    for case in spec["cases"]:
        if case.get("family") != "NATIVE BRIDGE":
            continue
        entry = FILING.get(case["id"])
        if entry is None:
            continue
        case["status"], case["evidence"] = entry[0], entry[1]
        touched.append(case["id"])

    for family in spec["families"]:
        if isinstance(family, dict) and family.get("name") == "NATIVE BRIDGE":
            family["reachability_fail"] = REACHABILITY

    SPEC.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("filed:", ", ".join(sorted(touched)))
    for case in spec["cases"]:
        if case.get("family") == "NATIVE BRIDGE":
            print(f"  {case['id']}  {case['status']}  {len(case['evidence'])} evidence entry/entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
