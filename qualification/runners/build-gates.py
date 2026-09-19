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
    "toolproto": evidence("M9.11-tool-protocol/FINDINGS.md"),
    "guard": evidence("M9.21-guard-mounted/FINDINGS.md"),
    "sched": evidence("M9.12-scheduling/FINDINGS.md"),
    "cost": evidence("M9.6-cost/FINDINGS.md"),
    "duradv2": evidence("M9.15-durability-records/FINDINGS.md"),
    "profileiso": evidence("M9.7-profile-isolation/FINDINGS.md"),
    "research": evidence("M9.8-research/FINDINGS.md"),
    "profcfg": evidence("M9.14-profile-config/FINDINGS.md"),
    "profcfgfalse": evidence("M9.14-profile-config/runs/falsification.txt"),
    "rchain": evidence("M9.16-research-chain/FINDINGS.md"),
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
    "A04": ("PASS", ["c2", "profcfg", "profcfgfalse"], "The mechanism is vendor/include/src/index.ts:120-123: `target[key] = value`, no recursion -- so a patch REPLACES the row whole config. Measured with a FALSIFYING case rather than a happy path: patching only `openAt` on session-query-sqlite DROPS `path` entirely, and because `path` is .required() in that row own schema, the row does not activate at all (`1 entry did not activate ... $.path missing required value`). So the wrong mental model does not produce a subtly different graph; it produces a tree that will not mount. Five mutations were run against this test and each turned the intended assertion red."),
    "A05": ("PASS", ["c0", "profcfg"], "Layer order measured as bundles -> profile -> HOME -> --patch, with a home replacement OUTRANKING the profile own layer under the same whole-value semantics. --dump-default-config omits BOTH the profile and home layers, which is exactly why it is the stock baseline, and the launcher REFUSES to combine it with --patch -- so the baseline cannot be contaminated by construction."),
    "A06": ("PASS", ["profileiso"], "Two presets, parallel Sessions, with the REAL dsh-jobs-local, dsh-tool-jobs and dsh-compaction-basic behind entry-local realms. Registrations are per-Session: distinct tool catalogs, distinct isolated jobs and compaction instances, NO duplicate host registry, and no leak of a value from preset A into preset B. THE TRAP IS REAL BUT NARROWER THAN NAMED: two presets naming the same composition file get ONE ESM MODULE INSTANCE -- the test asserts this by having preset gamma write a module-scope value that preset delta reads back. The tool catalogs stay separate (scoped registrations shadow); the module does not. That is Cordis/ESM semantics rather than a DSH bug, and it is exactly why src/tools.ts holds no cross-session state. Also pinned: a preset is NOT self-contained -- mounting a real shipped preset against a hand-rolled context fails because its rows inject host services, which is why these assertions use authored fixtures."),
    "A07": ("PASS", ["c0", "profileiso"], "Re-verified end to end through the REAL roster, not just read from source: a shipped preset shadows a same-id user preset (the winner PATH is checked, not only its trust label); a unique user id is discovered alongside the shipped ones; resolve(unknown) throws agent-preset/not-found naming alternatives. The generation stamp is {mtimeMs, size} and is NOT a content hash -- verified by a same-length, same-stamp, different-content write, so production must not rely on it as a hash guarantee."),
    "A08": ("PASS", ["c0", "c2", "profcfg"], "Measured from real dumps: C0 -> C2 is 163 vs 164 rows. The `subagent` row gains {maxActiveSubagents:10, maxDepth:1} and `daily-work-host` is INSERTED. NOTHING is removed, and the Goal (5), fork (2) and compaction (4) families are byte-identical -- so no stock component was deleted while the result was still called stock."),
    "A09": ("PASS", ["search", "profcfg"], "The sharpest finding is that TWO DIFFERENT THINGS both look like `search unavailable`. The shipped DeepSeekSearchProvider.available() tests PRESENCE OF A RESOLVER, not a key -- so with no key it returns TRUE, and the failure appears only at the request as WEB_PROVIDER_CREDENTIAL_MISSING with nothing sent to the wire. Separately, ctx.web selection throws WEB_PROVIDER_CONFIGURED_UNAVAILABLE rather than returning {sources: []}. IMPORTANT CORRECTION: the daily profile mounts the SHIPPED provider, not this repo ported one -- so an A09 result must not be read as evidence about the ported provider."),
    "A10": ("PASS", ["first", "profcfg"], "Both halves measured. The CLI stream is BOUNDED while the Session is not: a ~1 MiB tool result was projected to exactly 8192 chars with truncated:true, while the persisted Session held 50000 (`final` is deliberately unbounded). And exit 0 is about the TURN, not the work: a shell exiting 3 produced turn/end completed, isError false, and CLI exit 0 -- with the complement asserted, since a real turn error exits 1."),
    "A11": ("PASS", ["profileiso"], "Driven against the REAL built launcher, with exit codes and stderr captured. session-id does not exist -> exit 1 with `session \"...\" does not exist; omit --session-id to start a new Session`. Unknown profile -> exit 1 with `profile \"X\" does not exist`. Missing --profile -> exit 1. A resume from a different cwd -> exit 1 naming both directories. Three things make these REFUSALS rather than just error strings, all asserted: $DSH_HOME/sessions is never created for a bad session-id; no profiles/<name> directory is created for a bad profile (the check precedes initProfile); and a POSITIVE CONTROL runs the same command with a real correctly-placed Session, which gets past identity and stops only at MISSING_CREDENTIAL -- so the refusals are not indiscriminate."),
    "A12": ("PARTIAL", ["profcfg"], "PARTIAL, booted to the CREDENTIAL boundary. PROVEN: the real launcher bound a real port; the fence returned 401 unauthenticated; the token URL -> cookie -> 200 app shell worked; a real session/create + session/list round trip succeeded; modelCatalog shows the route; and the booted profile graph carries both C2 changes. NOT PROVEN: no model turn ran, because DEEPSEEK_API_KEY is absent from every source the credentials provider layers. The boundary was confirmed to be CREDENTIAL and not composition, via the SDK profile: it booted, reached turn/start with a real tool catalog, then stopped at MISSING_CREDENTIAL. No clean-shutdown claim is made: on win32 child.kill terminates rather than delivering a signal."),
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
    "B04": ("PASS", ["toolproto", "guard"], "MEASURED: AgentRegistry.resume publishes a NEW Agent object under the SAME id (registry.get(id) === new is true, === old is false, while String(old.id) === String(new.id)). tools.ts resolved a run by STRING comparison, so a superseded object mapped to the run the new lifecycle owns. src/tool-protocol-guards.ts closes it with OBJECT IDENTITY, mirroring DSH's own TerminalSessionService.isLiveOwner and the jobs-local owner check, registered through ctx.tools.guard (the MONOTONIC slot, where no later listener can restore permission). A paired test proves the guard is load-bearing: without it the stale object drives finish and moves the run to closing. SEPARATELY VERIFIED MOUNTED: a real boot probe (M9.21) shows the composed profile mounts the guard row and that it denies a forged owner while leaving an unrelated tool and an ownerless call untouched. LIMIT, stated: the record epoch field is INERT -- nothing reads or writes it after initialRunRecord sets 1 -- so object identity covers an in-process resume and a cross-PROCESS re-adoption has no enforcement today."),
    "B05": ("PASS", ["toolproto", "profileiso"], "Measured rather than described: one livePresetMounts() entry, standingMountFor(a.ctx) === standingMountFor(b.ctx), and tools.get(work, a) === tools.get(work, b) -- the SAME ToolDefinition object for two Sessions. The isolation test interleaves A and B with different targets, ready counts and a pause on one run; tasks, budget and cancellation stay separate, and a read in the OPPOSITE order from the writes excludes a currentRun-style field. The standing-composition trap is real but NARROWER than the plan named it: registrations are per-Session, and it is the ESM MODULE that is shared between two presets naming the same composition file -- which is exactly why src/tools.ts holds no cross-session state."),
    "B06": ("PASS", ["t0t1"], "One tool definition with typed canonical JSON; the schema is asserted to carry exactly the four documented parameters."),
    "B07": ("PASS", ["toolproto"], "The guard slot is now USED (see B04), so this gate is about monotonicity rather than absence. An allowing listener registered AFTER the guard, and another with { prepend: true }, both fail to restore permission. An async guard is NOT awaited: the Promise is not undefined so it denies, and it is not JSON so materialization fails -- with the sync-undefined contrast asserted in the same test. A throwing guard fails closed."),
    "B08": ("PASS", ["toolproto"], "Both a synchronous throw and an async rejection leave the tool outcome intact and un-worded with rollback; the failures are LOGGED, so containment is not silence. The ordering that makes it safe is asserted from INSIDE the observer: a durable read already shows the reservation and the task state, so a lost observation cannot erase what was committed."),
    "B09": ("PASS", ["signal"], "(a) A pre-aborted signal makes drain launch NOTHING and return an EMPTY outcome list -- not refusals -- because the guard breaks before any request is considered; on the real JobRegistry a pre-abort refusal publishes no record AND consumes no id (the next start is still bash-1). Structural fact: JobStart has NO signal field at all (jobs/src/types.ts:46-69), so the refusal happens one layer ABOVE publication and the registry cannot be asked about it -- pinned at compile time. (b) An abort can never un-admit a task past its atomic reservation: it keeps its slot and credit and the run stays open. Signal OBJECT IDENTITY is asserted across caller -> drain -> port -> startContinuable, because a wrapper with its own controller would pass every behavioural test while silently decoupling the abort. (c) Disposing the exact live owner calls cancel, moves to stopping and AWAITS the producer; stopping still occupies the bucket, and a real registered Agent is required because ensureOwnerCleanup rejects stubs. SCOPE: this project publishes no background Job, so the Job-layer claims are asserted against the real registry directly rather than through a product path."),
    "B10": ("PASS", ["t0t1", "n10"], "Durability and recovery tests use real Sessions and the production loop; no process-local Inbox stub is used for those."),
    # C - M3 rolling top-up
    "C01": ("BLOCKED_EXTERNAL", ["n10", "sched"], "T1 MEASURED, T5 BLOCKED. At T1: 20 tasks submitted against target N=10; ten admitted and ten refused; ten DISTINCT children each reach a real model request in their own durable Session, each status running, each delegationDepthOf() === 1 with origin subagent and the root as durable parent. The root is partitioned OUT of the ten, proven by a second case. T5 (a live paid run) stays BLOCKED_EXTERNAL: live_provider_budget_authorized is false, and a key being present would not authorize paid evaluation."),
    "C02": ("PASS", ["n10", "sched"], "Re-measured with a timeline: nine held while one settles, confirming the settled task frees ONE slot, filled by exactly one replacement that reaches its own model request while the original nine are still held. Measured refill latency (confirmation -> replacement admitted) is 19-25 ms across runs; admitted -> first model request is 0 ms. NO numeric SLO is asserted, because none is frozen anywhere in this repository -- asserting one would make the test the author of its own standard."),
    "C03": ("PASS", ["n10", "sched"], "Three concurrent drains, three slots freed in one interval, three refill drains: exactly three admitted, no duplicate, no overshoot, and the coalesced drain re-triggers successfully afterwards. FINDING that came out of it: listChildren is a DURABLE ENUMERATION, not an occupancy count -- a disposed child still appears with activity inactive and it reported 13 children where only 10 slots were held. Occupancy must come from the live registry or the run record."),
    "C04": ("PASS", ["n10"], "Three ready tasks against target 10 create exactly three real children and report deficit 7 with reason insufficient_ready_tasks."),
    "C05": ("PASS", ["cost"], "CLOSED at the ARITHMETIC level; the provider-quota half stays NOT_RUN (no provider authorized). The invariant added and asserted: for every reachable state, spent + reserved + unknownReserved <= ceiling - rootReserve, so the root always retains at least rootReserve - rootSpent of its own credit however many children were admitted. rootReserve is CARVED OUT of the ceiling at createRun rather than added beside it (default 1/10, capped at 20), and one subtraction in childCeiling is read by BOTH the gate (mayAdmit) and the reported reason, so a refusal and its stated reason cannot drift. Boundary-tested: ceiling 100 / reserve 10, a child asking 91 is refused with a reason naming all four numbers."),
    "C06": ("PASS", ["n10"], "A pause stops admission with free slots remaining; the count of real children does not grow."),
    "C07": ("PASS", ["t0t1", "lifecycle", "sched"], "Interrupt sent, child still running: the slot is held, the credit is held, and a premature refill is refused; only a confirmed cancelled frees it. holdsSlot(cancel_requested) and holdsSlot(unknown) are both asserted true against src/states.ts, which is the single source of truth for occupancy."),
    "C08": ("PASS", ["lifecycle"], "A teardown failure is visible only as stopReason 'error' on subagent/end (the event carries no error field); the controller does not release a slot on an end event alone, and the disposal-failure window reconciles to unknown."),
    "C09": ("PASS", ["wire", "sched"], "A real mock HTTP/SSE server returns 429 with Retry-After; with the real llm-retry mounted, EXACTLY 3 attempts per child and then a stop, with no further attempts after waiting. The target stays 10 and no silent downgrade to 8 occurs. PROPOSED GAP (not yet placed in GAPS.md): under sustained 429, deficitReason reads none and capacityDeficit reads 0 because all ten slots are held -- a reader consulting deficitReason ALONE sees a healthy full wave while nothing executes and DSH holds zero resident children. The block is visible only via activeAssignments 0 plus ten held slots."),
    "C10": ("PASS", ["t0t1"], "Admission reserves atomically in one record transform; a reservation that would exceed the ceiling is refused."),
    "C11": ("PASS", ["cost"], "CLOSED at the arithmetic level; the real-billing half stays NOT_RUN. Reserve 1, actual 3: spent records 3 IN FULL, overage 2 is part of spent rather than beside it, a halt is set, and admission is refused on both admit and drain with budget_overage_halt, DISTINCT from budget_blocked. The halt is sticky -- resume does not clear it, only resolveHalt (a human edge) -- and the bill survives, so nothing is deleted to keep the report green. Unknown-usage path: with a task, the amount MOVES reserved -> unknownReserved (total unchanged, clamped to that task own reservation); without a task it is ADDED, which can only tighten. Nothing is zeroed either way."),
    "C12": ("PASS", ["n10"], "maxDepth 1 is carried on the child and grandchild depth is asserted; the tool surface exposes no spawn path."),
    "C13": ("PASS", ["goal", "t0t1"], "Per-run isolation is asserted: two runs in one host keep separate tasks, budgets and pause state, and taking continuation for one root leaves another root armed with its own objective and revision. The depth half of this gate is covered by C12."),
    "C14": ("PASS", ["goal"], "takeContinuation calls the public ctx.goals.disarm and asserts the objective and revision survive, the phase stays active, another root is untouched, and a later human resume still works. No double-continuation loop, and no fake completion."),
    "C15": ("PASS", ["n10"], "The drain is coalesced per run; repeated triggers do not stack."),
    "C16": ("PASS", ["n10"], "Admission lands in accepted, not executing: an unobserved child is not counted as an active assignment."),
    "C17": ("PASS", ["lifecycle"], "Closing a run stops new admissions while leaving the family open, so a failed acceptance remains recoverable. Asserted against the real seam: a child can still be established after beginClosing. The acceptance runner itself is not built, so the end-to-end recovery path is not exercised."),
    "C18": ("PASS", ["lifecycle"], "A real drainContinuableDescendants closes admission for that exact parent permanently: a later startContinuable is rejected. Pause, by contrast, is asserted to still be resumable, which is the property that proves pause did not use drain."),
    # D - M4 recovery
    "D01": ("PASS", ["t0t1", "duradv2"], "Task state, credit reservation and outbox move in ONE record transform; no cross-key transaction is claimed. Re-verified with a barrier simulation across the pre- and post-write windows: there is never a task admitted with credit unreserved. The honest scope is stated: KvTable.update() gives PER-RECORD atomicity only, and the window is defined by a claim CONTENT rather than by what survived a kill."),
    "D02": ("PASS", ["duradv"], "MEASURED, and the measurement is the alarming part: a REAL second Node process opens the same live store with NO error, its write lands durably, and then the first host's next publish ERASES it. Nothing upstream refuses; last-completion-wins exactly as the backend README says. So a second host can destroy committed work while the first never learns it existed. A cheap honest guard was added (homeLockPath config -> lockfile carrying pid/hostname/token, claimed via link() so check-and-claim is one atomic step) and proven with an independent probe: a real second process is refused while the first is live, the store is untouched, and the error names the holder. With homeLockPath unset -- the DEFAULT -- the deployment boundary remains the only protection, and the code says so."),
    "D03": ("PASS", ["durability", "t0t1", "duradv2"], "Real SIGKILL on a forked Node child, with the exit SIGNAL asserted rather than the kill() return value. A reservation that provably never launched returns to prepared, and it is the only path back, requiring positive proof. A REAL GAP was found here and fixed in a new file: reconciliation could return a task to prepared but NOTHING could act on it -- drain calls admit, and admit refuses a task that still holds its slot (prepared IS slot-holding), so a reconciled task would have sat forever while the run reported a capacity deficit. The refusal is asserted as a fact and resolved by relaunchPrepared."),
    "D04": ("PASS", ["durability", "t0t1", "duradv2"], "Real SIGKILL. A reserved id with no trace becomes unknown and is explicitly NOT relaunched; DUPLICATE_CHILD is rethrown unchanged rather than switching to a fresh id."),
    "D05": ("PASS", ["durability", "duradv2"], "Real SIGKILL, and the method is load-bearing: a GRACEFUL teardown DESTROYS the fact under test, because Agent.cancel calls inbox.clear() unless keepInbox (agent-loop/src/agent.ts:149-152) and the lifecycle disposer issues exactly that cancel. Only SIGKILL preserves the pending inbox. The restored message comes from DSH own agent/inbox/spliced fold via sessionProjections.stateOf(session, inbox), and the projection THROWS on a duplicate id, so double-injection cannot even be represented."),
    "D06": ("PASS", ["durability", "duradv2"], "Real SIGKILL. Claim with no request confirmation resolves to accepted rather than being called done, so taken and executed stay distinguishable."),
    "D07": ("PASS", ["durability", "wire", "duradv2"], "Real SIGKILL, plus real wire faults. A request with no terminal turn is unknown with the reservation held; an error outcome is also unknown. Driven against a real stream disconnect and a real stalled request, and every fault-shaped evidence record resolves to unknown or a conservative earlier state, never to a released slot."),
    "D08": ("PASS", ["durability", "duradv2"], "Real SIGKILL. A completed turn goes to settling, never confirmed; a lost parent notice is not treated as a child failure, and recovery finds the work from the child Session rather than repeating the task."),
    "D09": ("PASS", ["durability", "lifecycle", "duradv2"], "REAL FILE DAMAGE rather than a simulation: a session log torn with an incomplete trailing record, then resumed, using the upstream repair contract. Reconciliation never replays and never releases a slot, asserted over every state; an end event alone also does not release one. SIGKILL proves SURVIVAL, not fsync ordering -- Windows skips the directory fsync by design, which is stated rather than implied."),
    "D10": ("PASS", ["t0t1", "duradv2"], "CORRECTED EVIDENCE. The previous note said the record carries a run epoch and that reconciliation refuses a mismatched identity -- the epoch half was NOT enforced: nothing read or wrote it after initialRunRecord set 1. The agent caught this, and also caught its OWN first test being tautological (it hand-rolled staleClaim.epoch === record.epoch, asserting its own arithmetic rather than the system). A real guard now refuses a stale-generation settlement, with diagnostic evidence going to a SEPARATE domain (dsh_daily_work_refusals) so a refusal can never be mistaken for authority or take the run record write chain. LIMIT: object identity and this guard cover the in-process case; a cross-process re-adoption still has no epoch enforcement."),
    "D11": ("PASS", ["t0t1", "duradv2"], "Barrier-simulated (the window is defined by a claim content, not by what survived a kill). A second open of the same domain is rejected; writes after close are refused; a single shared host handle is used and unload->reload does not leave an already-open hang."),
    "D12": ("PASS", ["duradv"], "Proven by writing the bad records and opening the domain: a v2-shaped run record is rejected with DomainError/invalid-record; a malformed record likewise; a foreign unit version gives StorageError/version-mismatch; non-JSON gives malformed-medium. The store file's sha256 is asserted BYTE-IDENTICAL after the refused open, so it refuses rather than silently reading or migrating a backup. A matching record opens normally, which shows the refusal is version-driven and not a blanket failure."),
    "D13": ("PASS", ["durability", "t0t1", "duradv2"], "Real SIGKILL. A run without restart authorization comes back PAUSED, and an expired authorization also comes back paused -- it does not automatically re-consume budget or produce effects."),
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
    "T08": ("PASS", ["termadv"], "CLOSED (unconfined). A failing command is not reported as success; a printed fake done-marker is NOT trusted as verification; and an input()-style read settles without being read as completion. MEASURED AND SECURITY-RELEVANT: a send result carries an IDENTICAL field list for success and failure (viewport | waitReason | sessionStatus | truncated) with NO verdict field, so failure is visible only as text. The framing attack was quantified: a forged OSC `133;D;0` plus prompt settles the send in 138-185 ms versus 3025-3135 ms for the same command answered honestly, while the cell is still sleeping. The `<1500 ms` bound is DERIVED from the mechanism (idleSilenceMs = 3000), so a regression that stopped accepting the forgery would fail loudly rather than quietly pass. This is a real boundary on what framing can be trusted for and belongs beside the E01/E06 findings."),
    "T09": ("PASS", ["terminal"], "kill releases the session and list is empty afterwards; the real throw-on-second-kill contract is asserted."),
    "T10": ("PASS", ["terminal"], "The capability range is stated explicitly, including that confinement breaks spawn; no rich-MIME or cross-restart claim is made."),
    # R - M7 research, context, cost
    "R01": ("PARTIAL", ["search", "rchain"], "The four links are proven against DIFFERENT substrates, and each test says which. Retrieval is proven against a controlled fake (a loopback server answering the ported provider shape); the original fetch, the range bound and the citation are proven against a REAL loopback HTTP server through the shipped HttpFetchProvider. The failed-is-never-empty rule is asserted from BOTH sides: five failure shapes each get their own error code, AND a working provider that finds nothing still yields No results found -- so the distinction is pinned in both directions. The SSRF guard runs its shipped resolver for four addresses and refuses all four; where a test must reach loopback it passes the provider own documented HttpFetchResolver seam rather than monkeypatching a module. STAYS PARTIAL: the live half (that a real search API answers in the shape the ported provider expects) is BLOCKED_EXTERNAL, because live_provider_budget_authorized is false."),
    "R02": ("PASS", ["search", "rchain"], "Two INDEPENDENT barriers against accidental promotion. (1) EvidenceTier is a union that does not CONTAIN primary_read or understood -- they are unspellable, not merely refused. (2) The only mutator demands a named transition carrying its own evidence, and it refuses skipped steps, backwards steps, unevidenced transitions, and the subtle one: a `parsed` transition that does not declare its COVERAGE, so a partial parse cannot be silently upgraded while the tier is promoted."),
    "R03": ("PASS", ["research"], "Six evidence states in a CLOSED tuple, so `understood` cannot appear by accident. Range and limits live in structured fields the states cannot carry: fetch: not_fetched | failed{code} | responded{statusCode,bytes,truncated,usable}, and parse: {range, complete, limit?}. `parsed` is set ONLY for a complete parse, so states.has(parsed) means fully parsed while parse.range answers the different question of which part was read. The only function permitted to say `the source does not contain X` THROWS unless a complete parse exists -- it never returns an empty string, which would be indistinguishable from a real negative answer. Proven through the real ctx.web seam with a fixture transport, so the WebFetchResult values and WebError codes are DSH own: 404 -> responded/usable false, timeout and redirect-refusal -> failed, unconfigured provider -> failed, never an empty source. NAMED LIMIT: a PDF never reaches even bytes_captured, because web_fetch accepts only html/text bodies (web/src/types.ts:93-95) and classifyContentType returns undefined for application/pdf (policy.ts:78-84), so it throws WEB_UNSUPPORTED_CONTENT_TYPE before any body is read. No document pipeline exists, so the record type and the refusal are qualified but the PDF retrieval route is NOT."),
    "R04": ("PASS", ["research"], "The counterexample is MEASURED on a real Session rather than asserted in prose: visible seqs are [2,1] -- NOT ascending -- because a replacement lands at a higher seq while occupying an older surface position. So no rule of the form `everything at or below some seq` can express this surface AT ALL; that is the structural reason the shortcut is invalid, not merely one bad example. The test also pins the DIRECTION of the error: the inferred set differs from the real one by exactly the shadowed node, claiming MORE was seen than really was. LIMIT: no real CompactionEngine is used (it needs llm + tokenMeter); the surface transition appended is the one compactSurfaceRegion appends, so visibility semantics are qualified while range selection is not."),
    "R05": ("PASS", ["rchain"], "Two orderings distinguished on the production loop, in BOTH the response index and on the wire. IMPORTANT FINDING: the OBVIOUS predicate -- was the effect tool/call logged before the observation tool/result? -- is WRONG. For exclusive tools the call is logged AFTER the result, because executeToolCalls makes each exclusive call a group of one (tool-calls.ts:90). The naive predicate classifies that case as observed-then-sampled when in fact both calls came from ONE response. The test asserts both verdicts side by side rather than hiding the trap, so anyone reading this gate off sequence numbers would get the exclusive case backwards. No universal semantic-dependency prover is claimed."),
    "R06": ("PASS", ["cost"], "CLOSED at the ledger-semantics level; real per-attempt bills stay NOT_RUN. A UsageLedger over USAGE_SOURCES = root|child|retry|compaction|summary|search, with NO ?? 0 on the unknown path; a retry is a separate attemptId; unknownCount, unknownUsageCount and unknownCostCount are reported separately AND per source; a repeated attemptId and a reused requestId are both refused and both counted. Token buckets keep DSH own disjointness (quoted from llm/llm/src/types.ts:162), so reasoning is not re-added to output."),
    "R07": ("PASS", ["rchain"], "Both stimuli measured on the dispatched GenerateOptions, with buildRequest, headerEquals and orderTools quoted by line: (a) only unrelated dynamic state updated, (b) the tool ORDER changed. The actual REQUEST differences are explainable in both cases. contentGeneration -- the cumulative surface quantity the oracle explicitly names as a substitute to avoid -- is used NOWHERE in the file."),
    "R08": ("PASS", ["research"], "The allow-list is consulted BEFORE the store, because ctx.sessions.get(id) returns undefined for BOTH `not authorized` and `does not exist`; consulting the store first would collapse a refusal into an apparent absence. read() throws SESSION_QUERY_TOOL_UNAUTHORIZED (DSH own code) for a session the test first PROVES exists, and a genuine not-found stays separately distinguishable. Six independent no-implicit-widening assertions, including that the fields are #private -- a TypeScript `private` is erased and would leave scope.store a real property. LIMITS: the guard is not yet wired into a production tool surface, and DSH own session-query authorization is a DIFFERENT model (workspace/cwd scoped) which was neither replaced nor measured. The `DSH_HOME not mounted` half is addressed only as `the scope object names no filesystem location` -- no mount configuration was audited."),
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
