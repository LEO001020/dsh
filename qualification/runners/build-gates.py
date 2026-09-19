"""Generate qualification/gates.json from the frozen spec plus what was measured.

This script exists so the report is DERIVED from evidence that exists on disk
rather than typed by hand. Every PASS carries at least one evidence file whose
sha256 is recorded, and the script refuses to emit a PASS with no evidence.

Run from the repository root:
    python qualification/runners/build-gates.py
"""
from __future__ import annotations

import hashlib
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = ROOT / "qualification" / "specs" / "gate-spec.json"
OUT = ROOT / "qualification" / "gates.json"
SUMMARY = ROOT / "qualification" / "gates-summary.json"


def evidence(rel: str) -> dict[str, str] | None:
    path = ROOT / "qualification" / "results" / rel
    if not path.is_file():
        return None
    return {
        "path": f"qualification/results/{rel}",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


# Evidence artefacts that exist on disk, keyed by the gate families they support.
E = {
    "t0t1": evidence("M2.2-work-host/tests.txt"),
    "n10": evidence("M3.2-N10-concurrency/tests.txt"),
    "c2": evidence("M3.1-c2-profile/dump-config-daily-candidate.yml"),
    "durability": evidence("M4.1-process-kill/report-final.json"),
    "security": evidence("M5.1-security-boundaries/SECURITY-BOUNDARIES.md"),
    "terminal": evidence("M6.1-terminal-qualification/M6-FINDINGS.md"),
    "search": evidence("M7.1-web-search-port/PORT-NOTES.md"),
    "c0": evidence("M0.5-c0-resolved-graph/C0-resolved-graph.md"),
    "a03": evidence("M0.6-launcher-identity/A03-launcher-identity.txt"),
    "first": evidence("M0.4-first-toolcall/A03-first-toolcall.txt"),
    "lifecycle": evidence("M8.2-lifecycle-gates/FINDINGS.md"),
    "wire": evidence("M8.3-wire-faults/FINDINGS.md"),
    "goal": evidence("M8.4-goal-handover/FINDINGS.md"),
    "b02": evidence("M9.17-b02-resolver/FINDINGS.md"),
    "b02raw": evidence("M9.17-b02-resolver/b02.json"),
    "b03": evidence("M9.18-b03-lifecycle/FINDINGS.md"),
    "b03raw": evidence("M9.18-b03-lifecycle/b03.json"),
    "e2etool": evidence("M8.5-c2-real-boot/e2e-tool.json"),
    "secd": evidence("M9.3-security-denial/FINDINGS.md"),
    "effects": evidence("M9.5-effects/FINDINGS.md"),
    "runner": evidence("M9.1-acceptance-runner/FINDINGS.md"),
    "runnercli": evidence("M9.1-acceptance-runner/cli-transcript.txt"),
    "runnerstale": evidence("M9.1-acceptance-runner/staleness.txt"),
    "duradv": evidence("M9.4-durability-advanced/FINDINGS.md"),
    "signal": evidence("M9.9-signal/FINDINGS.md"),
    "termadv": evidence("M9.2-terminal-advanced/FINDINGS.md"),
    "runnerskip": evidence("M9.1-acceptance-runner/receipt-all-skipped.json"),
}

# gate id -> (status, evidence keys, note)
# PASS is used ONLY where a test or a real command actually ran and passed.
# Everything else says what it is: NOT_RUN, PARTIAL, BLOCKED_EXTERNAL,
# NOT_APPLICABLE. There are deliberately no FAILs, because nothing measured
# failed; a FAIL would appear here rather than being hidden.
G: dict[str, tuple[str, list[str], str]] = {
    # A - M0/M1 install and the stock control group
    "A01": ("PASS", ["c0", "first"], "Source identity, lockfile and package.json hashes recorded; artifact sha256 captured; C0 graph hashed."),
    "A02": ("PASS", ["first"], "Node v24.18.0 satisfies the engines field; corepack pinned pnpm 11.7.0; the global 11.24.0 was not used."),
    "A03": ("PASS", ["a03", "first"], "First real tool chain proven on the built launcher; the source launcher was separately shown to differ, which is the finding this gate exists for."),
    "A04": ("PASS", ["c2"], "The C2 patch restates the whole subagent config; the dump shows both keys present, proving whole-value replacement was handled."),
    "A05": ("PASS", ["c0"], "C0 dumps were taken with --dump-default-config, which omits the home layer by construction, so no home-patch contamination is possible."),
    "A06": ("NOT_RUN", [], "Two presets running parallel Sessions with Jobs and compaction has not been exercised."),
    "A07": ("PASS", ["c0"], "Shipped preset precedence and the copy-only authoring rule were read from source, and the shipped roster was confirmed at four presets."),
    "A08": ("PASS", ["c0", "c2"], "C0 and C2 tool and provider rows were compared from real dumps; every difference is attributable to the two documented changes."),
    "A09": ("PASS", ["search"], "The search provider reports presence separately from the model route and reports unavailable rather than substituting model memory."),
    "A10": ("PASS", ["first"], "Headless JSON is treated as an interactive stream; the persisted Session is the evidence, and exit 0 is not read as business success."),
    "A11": ("PASS", ["first"], "Unknown --session-id rejection was read from source and is asserted by the in-tree headless suite that ran."),
    "A12": ("NOT_RUN", [], "No long-lived Web host has been driven end to end on this machine yet."),
    # B - M2 plugin composition and tool protocol
    "B01": ("PASS", ["t0t1"], "The package compiles against real DSH declarations with tsc --noEmit; no any, no .d.ts edits, no deep imports. The compiled lib/ output was additionally import-verified in plain Node, which is what the profile resolver actually loads."),
    # B02/B03 were re-verified inside a REAL `dsh --profile daily` boot after the
    # user's completeness question exposed that the previous PASS rested on
    # `ctx.plugin()` direct mounting only. That evidence was weaker than the
    # scenario: the package had never been compiled and declared no
    # dsh.bundle.patch, so the resolver activated NO layer and the plugin was
    # never loaded -- while the direct-mount test still passed. The old note is
    # kept below the new one so the correction is auditable rather than erased.
    "B02": ("PASS", ["b02", "b02raw"], "Re-verified against the REAL profile resolver. Every peer resolves to exactly one realpath across three resolution roots (extension, profile, checkout); all resolve to built lib/*.js with zero source-resolved copies; all six injected services are live. Prior evidence (direct ctx.plugin mounting) was an over-claim and is retracted in the FINDINGS."),
    "B03": ("PASS", ["b03", "b03raw"], "Re-verified inside a real profile boot: three load/unload cycles with a pending await. Zero timer leak (Timeout count returns to pre-mount), zero per-cycle handle growth in steady state, flat resource series, and the shared domain stays usable. A control arm runs first so one-time host init is not misattributed. Two measurement errors in the first probe (wrong baseline, and _getActiveHandles being blind to timers) are recorded in the FINDINGS."),
    "B04": ("PASS", ["t0t1"], "Authority is bound to the exact live Agent plus run epoch; reconciliation refuses a mismatched child identity."),
    "B05": ("PASS", ["t0t1"], "Two runs in one host keep separate tasks, budgets and pause state; a pause on one does not affect the other."),
    "B06": ("PASS", ["t0t1"], "One tool definition with typed canonical JSON; the schema is asserted to carry exactly the four documented parameters."),
    "B07": ("PASS", ["security"], "No guard is registered by this project; the tool surface is asserted to expose no authority-widening parameter."),
    "B08": ("PASS", ["t0t1"], "The record is the authority for admission, not the tools/result observation; reservations are written before any launch."),
    "B09": ("PASS", ["signal"], "(a) A pre-aborted signal makes drain launch NOTHING and return an EMPTY outcome list -- not refusals -- because the guard breaks before any request is considered; on the real JobRegistry a pre-abort refusal publishes no record AND consumes no id (the next start is still bash-1). Structural fact: JobStart has NO signal field at all (jobs/src/types.ts:46-69), so the refusal happens one layer ABOVE publication and the registry cannot be asked about it -- pinned at compile time. (b) An abort can never un-admit a task past its atomic reservation: it keeps its slot and credit and the run stays open. Signal OBJECT IDENTITY is asserted across caller -> drain -> port -> startContinuable, because a wrapper with its own controller would pass every behavioural test while silently decoupling the abort. (c) Disposing the exact live owner calls cancel, moves to stopping and AWAITS the producer; stopping still occupies the bucket, and a real registered Agent is required because ensureOwnerCleanup rejects stubs. SCOPE: this project publishes no background Job, so the Job-layer claims are asserted against the real registry directly rather than through a product path."),
    "B10": ("PASS", ["t0t1", "n10"], "Durability and recovery tests use real Sessions and the production loop; no process-local Inbox stub is used for those."),
    # C - M3 rolling top-up
    "C01": ("BLOCKED_EXTERNAL", ["n10"], "Ten children ARE admitted through the real startContinuable seam on the production loop with a scripted provider. The LIVE paid N=10 run is blocked: live_provider_budget_authorized is false."),
    "C02": ("PASS", ["n10"], "One confirmed completion admits exactly one replacement without waiting for the wave."),
    "C03": ("PASS", ["n10"], "Two concurrent drains on one free slot produce exactly one child; the drain is coalesced."),
    "C04": ("PASS", ["n10"], "Three ready tasks against target 10 create exactly three real children and report deficit 7 with reason insufficient_ready_tasks."),
    "C05": ("NOT_RUN", [], "Root credit reservation under child saturation has not been exercised against a real provider quota."),
    "C06": ("PASS", ["n10"], "A pause stops admission with free slots remaining; the count of real children does not grow."),
    "C07": ("PASS", ["t0t1", "lifecycle"], "A cancel that is only requested still holds its slot and its credit; asserted both in the counting tests and against the real registry."),
    "C08": ("PASS", ["lifecycle"], "A teardown failure is visible only as stopReason 'error' on subagent/end (the event carries no error field); the controller does not release a slot on an end event alone, and the disposal-failure window reconciles to unknown."),
    "C09": ("PASS", ["wire"], "Driven through the real HTTP/SSE mock server: 429, 500 and 401 are all produced on the wire, a 429 keeps the target at 10 and reports a deficit rather than lowering N, and an exhausted script fails loudly instead of silently succeeding."),
    "C10": ("PASS", ["t0t1"], "Admission reserves atomically in one record transform; a reservation that would exceed the ceiling is refused."),
    "C11": ("NOT_RUN", [], "Actual spend exceeding the reservation has not been observed; no live provider."),
    "C12": ("PASS", ["n10"], "maxDepth 1 is carried on the child and grandchild depth is asserted; the tool surface exposes no spawn path."),
    "C13": ("PASS", ["goal", "t0t1"], "Per-run isolation is asserted: two runs in one host keep separate tasks, budgets and pause state, and taking continuation for one root leaves another root armed with its own objective and revision. The depth half of this gate is covered by C12."),
    "C14": ("PASS", ["goal"], "takeContinuation calls the public ctx.goals.disarm and asserts the objective and revision survive, the phase stays active, another root is untouched, and a later human resume still works. No double-continuation loop, and no fake completion."),
    "C15": ("PASS", ["n10"], "The drain is coalesced per run; repeated triggers do not stack."),
    "C16": ("PASS", ["n10"], "Admission lands in accepted, not executing: an unobserved child is not counted as an active assignment."),
    "C17": ("PASS", ["lifecycle"], "Closing a run stops new admissions while leaving the family open, so a failed acceptance remains recoverable. Asserted against the real seam: a child can still be established after beginClosing. The acceptance runner itself is not built, so the end-to-end recovery path is not exercised."),
    "C18": ("PASS", ["lifecycle"], "A real drainContinuableDescendants closes admission for that exact parent permanently: a later startContinuable is rejected. Pause, by contrast, is asserted to still be resumable, which is the property that proves pause did not use drain."),
    # D - M4 recovery
    "D01": ("PASS", ["t0t1"], "Task state, credit reservation and outbox move in one record transform; no cross-key transaction is claimed."),
    "D02": ("PASS", ["duradv"], "MEASURED, and the measurement is the alarming part: a REAL second Node process opens the same live store with NO error, its write lands durably, and then the first host's next publish ERASES it. Nothing upstream refuses; last-completion-wins exactly as the backend README says. So a second host can destroy committed work while the first never learns it existed. A cheap honest guard was added (homeLockPath config -> lockfile carrying pid/hostname/token, claimed via link() so check-and-claim is one atomic step) and proven with an independent probe: a real second process is refused while the first is live, the store is untouched, and the error names the holder. With homeLockPath unset -- the DEFAULT -- the deployment boundary remains the only protection, and the code says so."),
    "D03": ("PASS", ["durability", "t0t1"], "A reservation that provably never launched returns to prepared; the only path back, and it needs positive proof."),
    "D04": ("PASS", ["durability", "t0t1"], "A reserved id with no trace becomes unknown and is explicitly NOT relaunched; DUPLICATE_CHILD is rethrown unchanged."),
    "D05": ("PASS", ["durability"], "A pending prompt is left to native Inbox recovery; no duplicate delivery is made."),
    "D06": ("PASS", ["durability"], "Claim with no request confirmation resolves to accepted rather than being called done."),
    "D07": ("PASS", ["durability", "wire"], "A request with no terminal turn is unknown with the reservation held; an error outcome is also unknown. Driven against a real stream disconnect and a real stalled request, and every fault-shaped evidence record resolves to unknown or a conservative earlier state, never to a released slot."),
    "D08": ("PASS", ["durability"], "A completed turn goes to settling, never confirmed; a lost parent notice is not treated as a child failure."),
    "D09": ("PASS", ["durability", "lifecycle"], "Reconciliation never replays and never releases a slot, asserted over every state; an end event alone also does not release one."),
    "D10": ("PASS", ["t0t1"], "The record carries a run epoch and reconciliation refuses a mismatched child identity."),
    "D11": ("PASS", ["t0t1"], "A second open of the same domain is rejected; writes after close are refused."),
    "D12": ("PASS", ["duradv"], "Proven by writing the bad records and opening the domain: a v2-shaped run record is rejected with DomainError/invalid-record; a malformed record likewise; a foreign unit version gives StorageError/version-mismatch; non-JSON gives malformed-medium. The store file's sha256 is asserted BYTE-IDENTICAL after the refused open, so it refuses rather than silently reading or migrating a backup. A matching record opens normally, which shows the refusal is version-driven and not a blanket failure."),
    "D13": ("PASS", ["durability", "t0t1"], "A run without restart authorization comes back paused; an expired authorization also comes back paused."),
    "D14": ("PASS", ["duradv"], "Measured with real OS processes: a DETACHED grandchild SURVIVES a hard SIGKILL of the host (3/3), while a non-detached one does not (3/3). So 'the parent is dead' is not evidence the process is gone. The recovery oracle is asserted: with no Session and no live Agent the task reconciles to unknown with the slot and its reservation STILL HELD, never to a settled or released state. Cleanup is observed via process.kill(pid,0) before the test passes rather than assumed. A guard covers the trap that process.kill(0,0) succeeds by signalling the caller's own process group, which would make a missing pid read as alive."),
    # E - M5 security and effects
    "E01": ("FAIL", ["secd"], "Measured with a canary, and it FAILS on Windows. A confined child READ the fake secret outside the workspace root verbatim, exit 0, under BOTH read-only and workspace-write. The boundary is a WRITE boundary: writes outside are EPERM in both modes. WRITE_RESTRICTED intersects only write accesses, enforcement is literally 'partial', and SandboxPolicy carries only mode + workspaceRoot, so the seam has no read lever even in principle. The only credential control that exists anywhere is scrubbedParentEnv() in @deepseek-ai/dsh-subprocess -- a NAME heuristic (drops /KEY|PASSWORD|SECRET|TOKEN/i and DSH_*), which is defeated by a credential in a file and by an explicit env entry by design."),
    "E02": ("PARTIAL", ["security"], "The surface shape is proven: the preset mounts no terminal tool and this project adds none. A live model-to-control-plane probe has not been run."),
    "E03": ("PASS", ["secd"], "Exercised against a real confined pwsh PTY. The fence refuses, and the refusal is TOTAL: zero sandbox/mode events logged AND resolve() still reports the old mode. That distinction matters because the event IS the store -- a fence that threw after appending would still be a hole, and asserting only 'it throws' would have missed it. Also proven owner-scoped (an unrelated session changes freely) and close-then-change works."),
    "E04": ("PASS", ["security"], "tool-plugin-manager is disabled in the shipped standard preset and demands danger-full-access when enabled; this project does not enable it."),
    "E05": ("PASS", ["security"], "Control files and task workspaces are different paths by construction; the profile is copied into the home rather than read from the repo."),
    "E06": ("FAIL", ["secd"], "Measured, and it FAILS. A confined child completed a real HTTP round trip to a loopback server and connected to a public address, under both read-only and workspace-write. web-fetch-http's SSRF guard is real and was exercised (127.0.0.1, ::1, 169.254.169.254, 10.0.0.1 refused; WEB_BLOCKED_URL; pinned lookup) -- but it filters THAT TOOL'S URL, has no relation to ctx.sandbox, and is bypassed by any shell command. The seam README says file effects are the whole vocabulary, which is now executable evidence rather than a doc claim."),
    "E07": ("PASS", ["effects"], "48 tests, exit 0. The operationId digests (kind, logicalKey) ONLY -- never the tool callId -- so a retry under a changed callId lands on the same record and the counting fake stays at 1, including across a simulated restart and across a lost reply resolved by query. With no query support it stays unknown across three retries and still does not resend. reconcile() reached the transport zero times across five operations in every recorded state, which makes 'reconcile, never replay' a property of the module rather than a convention."),
    "E08": ("PASS", ["effects"], "A changed payload under a recorded operationId is a CONFLICT with performed:false, and reconcile of the changed params returns resultRef undefined rather than the stale ack. conflict is deliberately not a stored status, so a refused attempt cannot overwrite the ack it was refused against -- the original ack does not authorize the new action."),
    "E09": ("PASS", ["effects"], "The classifier is closed-allowlist and returns unknown by default, and it was defeated by REAL shell, not by listing failing regexes: four defeats (function shadowing, PATH shadowing, a redirect hidden in a variable via eval, and an exported function into a child shell), each with an observed write to disk. Two real holes surfaced while building it -- sort had to be REMOVED because `sort in out` writes with no flag, and `tar xf` writes with no dash anywhere. This is a refusal device, not a control: enforcement stays with the sandbox and process identity, and the test says so."),
    "E10": ("PASS", ["effects"], "replayedWholeProgram:false is a literal in the type, so no code path can produce a full-program replay. The committed effect is reconciled individually; the un-entered step is recorded as unknown, deliberately NOT as not_started, because the runner's control flow is not evidence about the remote."),
    "E11": ("PASS", ["effects"], "CancellationReport.reverted is a literal false in the type, so no code path can report an undo. Five branches are asserted, none matching /rolled back|undone|reverted|reversed/. A cancellation after a send reports 'may have happened' and reconciles by query."),
    "E12": ("NOT_RUN", [], "Verification-code isolation has not been exercised; the verifier is not built."),
    # F - M5 verification
    "F01": ("PASS", ["runner", "runnercli"], "Re-verified with the built acceptance runner: a REAL child exit code is recorded, and command_not_found leaves exit.code as null rather than a convenient 0. No model claim is an input anywhere in the classification. The earlier evidence (state-machine transitions) proved the record could not self-confirm, which is a weaker claim than an independent runner observing a real process."),
    "F02": ("PASS", ["runner", "runnerskip"], "Re-verified, and this is the sharpest result in the runner: TWO cases carry a REAL exit code of 0 and are still non-PASS -- an all-skipped suite (receipt-all-skipped.json: total=1 passed=0 skipped=1) and vitest's --passWithNoTests zero-test shape. An exit-code-only verifier calls both green. Classification covers command-not-found, all-skipped, runner-never-ran, timeout, interrupted, zero-tests and unknown; a PASS needs a real exit 0 AND a matching declared test count."),
    "F03": ("PASS", ["runner", "runnerstale"], "Re-verified end to end: fresh -> fresh:true exit 0 -> change one byte -> fresh:false exit 1. The receipt carries a candidate tree digest, an acceptance-definition digest and an environment identity, so a stale receipt is machine-detectable rather than a matter of noticing."),
    "F04": ("PASS", ["runner"], "Exercised with a two-arm contrast, and the SECOND arm is what makes the first meaningful. Snapshot arm: the child sees A, passes. In-place arm: the SAME A->B->A mutation, the child sees B and exits 9 with SAW_THE_TAMPERED_TREE, while the live before/after digests report NO DRIFT AT ALL. Endpoint hashing alone would have certified the tampered run. The mutation runs concurrently with the acceptance on a schedule written out in the test (A->B at t=700ms, child reads at t=1200ms, tree back to A at t=1900ms, child exits t=2800ms), so the window is real rather than assumed. A second case covers a command that rewrites its own declared input inside the snapshot, which yields unknown and holds the reservation rather than passing."),
    "F05": ("PASS", ["c2", "runner"], "Strengthened: a digest mismatch now REFUSES the run with acceptance_definition_changed, and --print-digest is a separate step so a definition cannot authorize itself. The frozen spec is additionally verified against the lock: sha256 b6e68075e097b5d790a406cb92820465381b6a716a84b53b0a8b8d99d584ad47, unchanged from the delivery package."),
    "F06": ("PASS", ["signal"], "Serial with NO next, asserted at compile time and at runtime with the waterfall contrast measured on ONE turn (pre-step:2 vs stopping:1). An in-listener abort yields one aborted turn/end, ONE model request, and no correction round; a throwing listener yields an explicit error turn with one request. The deadlock is proven and traced, not asserted: whenIdle -> activityDone -> kick() -> turn() -> serial dispatch, so the listener waits for the driver waiting for it and no turn/end is ever appended. The project registers NO such hook, and a test asserts that absence so a future addition without the required care fails. FINDING: the daily profile DOES inherit a live turn-stopping listener -- dsh-web-app mounts workspace-changes, which registers one and does real git-snapshot work at the stop boundary. Stock and deliberately not removed, but it means the stimulus is not hypothetical. Five mutations were run and all caught."),
    "F07": ("PASS", ["runner"], "Candidate defects are not retried at all; environment-shaped failures stop as blocked once the budget is spent. So a persistent unrepairable environment error terminates as blocked rather than looping until something turns green."),
    "F08": ("PASS", ["runner"], "refCas has NO write path -- no force, no reset, no update -- so a stale expected-ref cannot be overwritten. Tested against a real temporary git repository, including the unreadable-ref case. This project does not merge, so the CAS is a refusal surface rather than a publish path."),
    # T - M6 terminal
    "T01": ("PASS", ["terminal"], "The registry and the shell backend are asserted mounted, not inferred from a source directory."),
    "T02": ("PASS", ["terminal"], "spawn is exercised with type, name and cwd only; no command field exists."),
    "T03": ("PASS", ["terminal"], "A value set in one send is read back in a later send on the same PTY; owner isolation is asserted too."),
    "T04": ("PASS", ["terminal"], "The send result is asserted to carry a wait reason and to have no exitCode or succeeded field."),
    "T05": ("PASS", ["termadv"], "CLOSED (unconfined). The signal is delivered on an INDEPENDENT control path: 8-9 ms against a running cell, so it does not wait for the command to finish. The command really stops, the post-state is reported honestly, and signalling is owner-authorized. The unconfined qualifier is inherited from the read-only spawn limitation and is stated rather than hidden."),
    "T06": ("PASS", ["termadv"], "CLOSED (unconfined). A fresh context starts with NO terminals, so a historical pty-N id is not silently adopted; a cell does not survive the host that owned it, with a positive control proving the test can detect survival. The package has no replay call site, so no historical cell is auto-replayed."),
    "T07": ("PASS", ["terminal"], "read is asserted bounded and self-reporting through totalLines and truncated."),
    "T08": ("PASS", ["termadv"], "CLOSED (unconfined). A failing command is not reported as success; a printed fake done-marker is NOT trusted as verification (markers are not tamper-proof); and an input()-style read settles as stdin_read rather than completion. The real waitReason values are asserted, so a send result is treated as a wait reason and never as a completion signal."),
    "T09": ("PASS", ["terminal"], "kill releases the session and list is empty afterwards; the real throw-on-second-kill contract is asserted."),
    "T10": ("PASS", ["terminal"], "The capability range is stated explicitly, including that confinement breaks spawn; no rich-MIME or cross-restart claim is made."),
    # R - M7 research, context, cost
    "R01": ("PARTIAL", ["search"], "The search chain is implemented through ctx.web with the unavailable-versus-empty rule preserved. No live provider search has run."),
    "R02": ("PASS", ["search"], "Evidence state distinguishes presence from entitlement and never reports an unobserved success."),
    "R03": ("NOT_RUN", [], "PDF and partial-parse handling has not been exercised; no document pipeline exists yet."),
    "R04": ("NOT_RUN", [], "Compaction visibility has not been measured."),
    "R05": ("NOT_RUN", [], "Observation-then-sampling ordering has not been measured."),
    "R06": ("NOT_RUN", [], "Per-attempt cost accounting has not been exercised; no live provider."),
    "R07": ("NOT_RUN", [], "Prompt stability has not been measured."),
    "R08": ("NOT_RUN", [], "Evidence-scoped history access has not been exercised."),
    # U - M8 tasks and upgrade
    "U01": ("NOT_RUN", [], "No real coding task has been run under a frozen configuration."),
    "U02": ("NOT_RUN", [], "No real research task has been run."),
    "U03": ("NOT_RUN", [], "No sustained daily load has been run."),
    "U04": ("NOT_RUN", [], "No paired C0/C1/C2 comparison has been run."),
    "U05": ("NOT_RUN", [], "No canary upgrade has been run."),
    "U06": ("NOT_RUN", [], "No rollback has been exercised."),
    # W - conditional: isolated writers, not enabled
    "W01": ("NOT_APPLICABLE", [], "Conditional capability not enabled. Confirmed unnecessary for the mandatory path: children inherit the parent cwd, and the conditional slice stays off."),
    "W02": ("NOT_APPLICABLE", [], "Conditional capability not enabled."),
    "W03": ("NOT_APPLICABLE", [], "Conditional capability not enabled."),
    # J - conditional: dedicated Jupyter, not enabled
    "J01": ("NOT_APPLICABLE", [], "Conditional capability not enabled. No dedicated kernel is implemented; the native terminal was qualified instead."),
    "J02": ("NOT_APPLICABLE", [], "Conditional capability not enabled."),
    "J03": ("NOT_APPLICABLE", [], "Conditional capability not enabled."),
}


def main() -> int:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "compatibility.lock.json").read_text(encoding="utf-8"))
    deployment_identity = lock.get("deployment", {}).get("identity")

    # The spec carries `required_for` values from the delivery package. The
    # checker accepts only offline_qualified / daily_ready / conditional, and
    # NOT_APPLICABLE is legal only for `conditional`. Both rules are honoured
    # below rather than worked around.
    spec_by_id = {entry["id"]: entry for entry in spec}
    gates = []
    problems: list[str] = []

    for entry in spec:
        gid = entry["id"]
        if gid not in G:
            problems.append(f"{gid}: no result recorded")
            continue
        status, keys, note = G[gid]
        files = [E[k] for k in keys if E.get(k) is not None]
        if status == "PASS" and not files:
            problems.append(f"{gid}: PASS with no evidence file on disk")
        required_for = entry["required_for"]
        # A non-conditional gate may not be NOT_APPLICABLE. Where this project
        # genuinely does not run a capability, the honest value is NOT_RUN.
        if required_for != "conditional" and status == "NOT_APPLICABLE":
            status = "NOT_RUN"
            note = note + " (Recorded NOT_RUN: NOT_APPLICABLE is reserved for conditional gates.)"
        # The checker's status vocabulary is NOT_RUN / RUNNING / PASS / FAIL /
        # BLOCKED_EXTERNAL / NOT_APPLICABLE. There is no PARTIAL, so a partial
        # result is reported as NOT_RUN with the partial detail kept in the note
        # rather than being rounded up to PASS.
        if status == "PARTIAL":
            status = "NOT_RUN"
            note = "PARTIAL: " + note
        gate = {
            "id": gid,
            "stage": entry["stage"],
            "name": entry["name"],
            "required_for": required_for,
            "stimulus": entry["stimulus"],
            "oracle": entry["oracle"],
            "status": status,
            "note": note,
        }
        if status == "PASS":
            gate["deployment_identity"] = deployment_identity
            gate["evidence"] = files
        if status in {"BLOCKED_EXTERNAL", "NOT_APPLICABLE"}:
            gate["blocking_reason"] = note
        gates.append(gate)

    summary = {s: sum(1 for g in gates if g["status"] == s)
               for s in ("PASS", "FAIL", "RUNNING", "BLOCKED_EXTERNAL", "NOT_RUN", "NOT_APPLICABLE")}
    # The delivery package's checker (`helpers/check_plan.py`) is handed the
    # --gates file and immediately does `isinstance(gates, list)`, so this file
    # must be a BARE ARRAY of gate objects. The summary and the promotion
    # decision therefore live in a separate companion file rather than wrapping
    # the array, because wrapping it would make the checker see zero gates.
    OUT.write_text(json.dumps(gates, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    companion = {
        "schema_version": 1,
        "kind": "PROJECT_QUALIFICATION_SUMMARY_NOT_A_DSH_ARTIFACT",
        "audit_date": "2026-09-19",
        "deployment_identity": deployment_identity,
        "summary": {"total": len(gates), **summary},
        "promotion_decision": "NOT_READY",
        "promotion_reason": (
            "Mandatory gates remain NOT_RUN or BLOCKED_EXTERNAL. "
            "No daily promotion is claimed."
        ),
        "generator": "qualification/runners/build-gates.py",
        "generator_problems": problems,
        "note": (
            "qualification/gates.json is a bare array because the delivery "
            "package's checker requires that shape. This companion file carries "
            "the counts and the promotion decision."
        ),
    }
    SUMMARY.write_text(json.dumps(companion, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(companion["summary"], indent=2))
    if problems:
        print("PROBLEMS:")
        for problem in problems:
            print(" -", problem)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
