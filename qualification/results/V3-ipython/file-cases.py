"""File V3's IPYTHON verdicts into the live ledger. IPY cases ONLY.

Run once. Idempotent: it sets status + evidence on the 15 IPYTHON cases and
touches nothing else in the spec.
"""
import hashlib
import json
import pathlib

ROOT = pathlib.Path("D:/DSH/work/dsh-native-daily")
SPEC = ROOT / "qualification/specs/acceptance-spec.trusted-local-v1.json"
IDENTITY = "0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461"

GATES = "qualification/results/V3-ipython/run-v3-spec-gates.txt"
LIFECYCLE = "qualification/results/V3-ipython/run-lifecycle.txt"
FAULTS = "qualification/results/V3-ipython/run-faults.txt"
BOOT = "qualification/results/V3-ipython/IPY-09-boot.txt"
BOOTJSON = "qualification/results/V3-ipython/IPY-09-tool-surface.json"
BUILD = "qualification/results/V3-ipython/build-identity.txt"
EXPERIMENT = "qualification/results/V3-ipython/experiment-restart-single-variable.txt"
EXPERIMENT_MD = "qualification/results/V3-ipython/experiment-restart-analysis.md"


def sha256(rel):
    return hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()


def ev(path, note):
    return {
        "path": path,
        "sha256": sha256(path),
        "identity": IDENTITY,
        "note": note,
    }


BUILD_NOTE = (
    "build + identity this measurement was made against: HEAD and branch, the "
    "recomputed deployment identity, and the lib/ + src/ digests. The link: homes "
    "resolve the built lib/, so a stale-build result would be visible here."
)

VERDICTS = {
    "IPY-01": ("PASS", [
        ev(GATES, "12/12 passed. [measured] one cell through KernelService: get_ipython() is ipykernel.zmqshell.ZMQInteractiveShell, the isinstance check against ZMQInteractiveShell is True, and %who listed a variable defined in the SAME cell. A plain-CPython interpreter raises SyntaxError on the magic line, so the magic executing is the discriminator."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-02": ("PASS", [
        ev(GATES, "12/12 passed. [measured] cell 2 used a DataFrame, a function and an import it does NOT define; the cell-2 SOURCE is asserted mechanically free of all four definitions, which is the oracle's second sentence. Values were 12 / 200 / {\"a\": 1} in the same epoch, so the persistence is real rather than an earlier input re-read."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-03": ("PASS", [
        ev(GATES, "12/12 passed. [measured] one cell awaited an asyncio task (value 42) AND a native tool call through the DSH bridge, which returned the registry's own canonical value {marker: NATIVE-SETTLED, tag: from-the-cell}. The cell source was asserted to contain no async def, no asyncio.run and no run_until_complete."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-04": ("PASS", [
        ev(GATES, "12/12 passed. [measured] the assignment survived the raise and was read back in the next cell; the traceback carried the failing line; and the MODEL-FACING text produced by the real renderer matched no rollback phrasing while still containing the exception name. The wording half was established against the renderer's own output, not against a comment."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-05": ("PASS", [
        ev(GATES, "12/12 passed. [measured] input() failed in 453 ms and getpass in 34 ms, both StdinNotImplementedError, far inside a 30 s cell budget. The slot-release clause was asserted from the host's own view: host.busy was false after each failure and a further cell was accepted immediately in the same kernel, so a wedged stdin read is ruled out."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-06": ("PASS", [
        ev(GATES, "12/12 passed. [measured] three correlated kernel_info requests were interleaved while a cell ran; the cell was completed by its own reply+idle (its last line 'tick 5' and 'ipy06-cell-finished' present) and foreignFrames was reported to the caller with a control arm establishing the baseline of 1. The restart clause of the stimulus advanced the epoch and left the old namespace gone. CORRECTION RECORDED: the control arm showed the injected requests were CORRECTLY correlated rather than foreign, so an earlier assertion of mine that they would be counted as foreign was wrong and was fixed before filing."),
        ev(EXPERIMENT, "the DECISIVE single-variable restart experiment, raw transcript: WITH an intervening status() the restart passes in 1823 ms, WITHOUT it in 11852 ms. Both pass, so the hypothesis that the injected status() calls break a restart is refuted."),
        ev(EXPERIMENT_MD, "the four rounds of that experiment in full: arm B passed WITH the injection while arm C failed WITHOUT it; 3/3 trials failed at ~61 s at broker.py:839 wait_for_ready with an EMPTY kernel.err; the PRODUCT path (KernelService) failed too, with a distinct AttributeError from a torn-down router. Root cause NOT isolated -- a port collision during restart_kernel(now=True) is a candidate, not a finding."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-07": ("PASS", [
        ev(FAULTS, "11/11 passed. [measured] a CPU loop is interrupted with KeyboardInterrupt and the kernel is reusable; an await-suspended cell reports unknown with a reset and an epoch advance, explicitly NOT a graceful KeyboardInterrupt; a cell overrun reports unknown with a reason naming '6000 ms', a replaced pid, and the pre-timeout variable confirmed gone; and restart advances the epoch 1->2, replaces the process, loses the namespace, and preserves kernelCwd with kernelCwdEnforced true."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-08": ("BLOCKED_EXTERNAL", []),
    "IPY-09": ("PASS", [
        ev(BOOT, "[measured] a real boot of the deliverable profile through the shared port-safe harness: ipythonToolPresent true, ipythonParameterNames ['code'], ipythonIsOnlyParameter true, forbiddenLifecycleTools [], pythonExecAliasPresent false, toolCountAgentKey 27. Port reported released after the boot."),
        ev(BOOTJSON, "the probe's own JSON: the 27 registered tool names verbatim, and the presetRoots proving the result names THIS home (D:/DSH/home/v3-ipython) rather than another agent's file, which is the fixed-output-path guard."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-10": ("PASS", [
        ev(LIFECYCLE, "15/15 passed. [measured] inside a cell: has_ctx false, has_kernel_service false, has_ipython_service false, lifecycle_callables [], cap_or_timeout_symbols [], control_env 'pipe'. A cell that shuts its own kernel down via get_ipython().kernel.do_shutdown is reported as a NEW generation with volatileStateLost true and the epoch advanced -- observed and stated, never presented as continuity."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-11": ("PASS", [
        ev(GATES, "12/12 passed. [measured] for a Session started for the repo root, the cell reported cwd verbatim as the requested root; isTempDir false; a relative path resolved inside the root and packages/dsh-ipython was reachable through it; status.kernelCwdEnforced true with status.kernelCwd equal to the same value. This confirms the retraction of G-SEAM-29."),
        ev(LIFECYCLE, "15/15 passed. [measured] the same oracle per Session (two Sessions reach two different roots), plus the scratch-vs-cwd SEPARATION gate: cwd == Session root AND DSH_IPYTHON_KERNEL_DIR == DSH_IPYTHON_SPILL_DIR == scratch AND they differ AND kernel.out lands in scratch and not in the project, and a relative write lands in the project."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-12": ("PASS", [
        ev(GATES, "12/12 passed. [measured] cap 8192 bytes in force; a flooding cell reported truncated true with totalBytes 3276818; the MODEL-FACING projection said TRUNCATED, named the true total, named the spill path, and said the output is NOT complete. The spill file on disk was 3276818 bytes, so the loss is recoverable rather than merely declared."),
        ev(FAULTS, "11/11 passed. [measured] the cap bounds the IOPub projection; a direct fd-1 write of 5,000,000 bytes under a 4096 cap is reported as 10 bytes untruncated while kernel.out grows by exactly 5,000,000 -- a real silent-loss boundary, recorded as such rather than smoothed over."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-13": ("FAIL", [
        ev(GATES, "12/12 tests passed, and that is the point: the clause-2 test PINS the measured defect rather than passing over it. [measured] clause 1 HOLDS: a post-return write is classified late, carries the originating cell id, and rides no later cell. Clause 2 DOES NOT HOLD: the write landing during a later cell was ATTRIBUTED to that cell -- lateCount 0, and the marker appeared inside cell three's stdout between 'tick 1' and 'tick 2'. The oracle requires it be reported undecidable rather than attributed. Mechanism: ipykernel/iostream.py resolves the stream parent from a contextvars.ContextVar with a GLOBAL fallback, and threading.Thread starts with an EMPTY context, so the writer takes the global, which holds the LATER cell's id. The broker's router is correct on the information it has; the loss is upstream of it."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-14": ("PASS", [
        ev(GATES, "12/12 passed. [measured] after a hostile taskkill: epoch 1 -> 2 with a reason naming the dead process, volatileStateLost true, pid replaced; the MODEL text stated the state is LOST and that 'Nothing was replayed'; the Session stayed registered and the replacement kernel ran a further cell with the old name absent; and an append-only marker written by a cell that genuinely ran BEFORE the kill still had exactly ONE line, so nothing was replayed."),
        ev(FAULTS, "11/11 passed. [measured] killing the kernel reports a NEW epoch and a lost-state notice, and the replacement kernel is usable and empty."),
        ev(BUILD, BUILD_NOTE),
    ]),
    "IPY-15": ("FAIL", [
        ev(GATES, "12/12 tests passed, and the test PINS the measured gap. [measured] transport tcp with curveKeysPresent true and plaintextWarningSeen false; the connection file the kernel was given carries both curve_publickey and curve_secretkey, mode 0o666. An over-limit frame IS refused in both directions (encode throws; decode rejects on the DECLARED length with 'declared frame length 4194305 exceeds the 4194304-byte limit'), so nothing is silently lost at that layer. BUT the clause 'reported as LOST with a count' is NOT met: CellResult.stdout.droppedFrames is structurally always 0. [read in source] OutputBuffer.note_dropped_frame (broker.py:139), the only writer of that counter, has ZERO call sites, so the renderer branch for droppedFrames > 0 at ipython-tool.ts:69 is dead code."),
        ev(BUILD, BUILD_NOTE),
    ]),
}


def main():
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    seen = set()
    for case in spec["cases"]:
        if case.get("family") != "IPYTHON":
            continue
        cid = case["id"]
        seen.add(cid)
        status, evidence = VERDICTS[cid]
        case["status"] = status
        case["evidence"] = evidence

    missing = set(VERDICTS) - seen
    if missing:
        raise SystemExit("IPY cases in the spec not covered: %s" % sorted(missing))

    SPEC.write_text(json.dumps(spec, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("filed %d IPY cases" % len(seen))
    for cid in sorted(seen):
        print("  %-7s %-17s %d evidence" % (cid, VERDICTS[cid][0], len(VERDICTS[cid][1])))


if __name__ == "__main__":
    main()
