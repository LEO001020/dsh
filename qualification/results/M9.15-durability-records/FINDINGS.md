# M9.15: the durability record gates (D01, D03-D11, D13)

Evidence: `tests.txt` (real vitest output, 25 passed), `tsc.txt` (typecheck with
tests INCLUDED), `source-digests.txt`.

## Method per gate, and the honest result

`REAL KILL` = a forked Node child was SIGKILLed mid-window; the observed exit
signal is `SIGKILL` and that is asserted, not assumed. `SIMULATED BARRIER` = the
window is defined by a claim's CONTENT rather than by what survived a kill, so a
barrier expresses it directly; a kill would add nothing. `REAL FILE DAMAGE` = a
real artifact on disk was damaged and then resumed.

| Gate | Window | Method | Result |
|---|---|---|---|
| D01 | intent/credit/outbox write | SIMULATED BARRIER | PASS |
| D03 | durable task+childId, launch never called | REAL KILL | PASS (see gap G1) |
| D04 | accepted, parent never saved the result | REAL KILL + real registry | PASS |
| D05 | pending inbox at the moment of the kill | REAL KILL | PASS |
| D06 | claim written, request never sent | REAL KILL | PASS |
| D07 | request in flight, no result | REAL KILL | PASS |
| D08 | child artifact persisted, parent unnotified | REAL KILL | PASS |
| D09 | torn trailing record / flush error | REAL FILE DAMAGE | PASS |
| D10 | stale epoch settlement after restart | SIMULATED BARRIER | PASS (see gap G2) |
| D11 | repeated domain open, unload/reload | SIMULATED BARRIER | PASS |
| D13 | restart with paused/expired authorization | REAL KILL | PASS |

## What each gate actually proves

**D01.** One `admit` produces exactly ONE `domain/changed` event, and that event
carries the task, the credit reservation and the outbox entry together. This is
the assertion that makes "atomic admission" true rather than aspirational: the
domain gives per-record atomicity (`storage-domain/src/domain.ts:332-346`), and a
second key would not be covered by any transaction. A refused admission leaves
the record byte-identical, so neither half can land alone. Also asserted: the
record has ONE table (`runs`), so no cross-key transaction can even be claimed.

**D03.** The child writes task+childId+reservation and is SIGKILLed before any
launch port is installed. Recovery finds the ORIGINAL childId, the reservation
intact and `attempt` still 1, and relaunches under that same id exactly once.
Three refusals are asserted alongside it: a task in `unknown` is never relaunched
(the child may exist), a relaunch with a CHANGED assignment digest is refused,
and a second relaunch attempt loses because `prepared -> launching` is legal
exactly once. **This gate found a real gap — see G1.**

**D04.** The child is admitted through the REAL `ctx.subagents.startContinuable`
and enters a real request, then the process is killed. On restart, launching the
same reserved childId is refused by the real registry with
`code: 'DUPLICATE_CHILD'` naming that exact id. So "reconcile, never re-execute
under a fresh id" is enforced by DSH itself, and the message proves no new UUID
was minted anywhere on the path. Reconciliation then resolves the window to
`unknown` holding its slot.

**D05.** This one REQUIRED a real kill, and the reason is worth recording: a
GRACEFUL teardown destroys the fact under test. `Agent.cancel` calls
`inbox.clear()` unless `keepInbox` (`agent-loop/src/agent.ts:149-152`) and the
lifecycle disposer issues exactly that cancel (`agent-loop/src/index.ts:596`), so
a clean shutdown erases pending inbox messages. After SIGKILL, resuming the child
through the real loop restores the queued message from DSH's own
`agent/inbox/spliced` fold — read via `sessionProjections.stateOf(session,
'inbox')`, DSH's projection, not ours. Exactly one copy survives; the projection
itself throws on a duplicate id (`inbox.ts:44-52`), so a double injection cannot
even be represented. The record's task shape is also asserted to contain no
field that could hold pending input: there is no second inbox.

**D06.** The claim is durable (`agent/inbox/spliced` with a removal) and no
`request/header` exists — the two facts are distinguishable in the log, which is
what makes "taken" different from "executed". Verified by real kill, then by
reading the resumed Session. The crash-orphaned turn is closed by DSH with
`reason: {kind: 'interrupted'}`. Reconciliation returns `accepted` (holding the
slot), never `confirmed` or `settling`.

**D07.** `request/header` and `request/context` are durable, the request is in
flight at the provider, and no `assistant/message` exists when the kill lands.
Every fault-shaped reading of this window (`undefined`, `interrupted`, `error`)
resolves to `unknown` with the reservation held and `holdsSlot(next) === true`,
so the credit cannot be reclaimed as free. An unprobed task is quarantined too.

**D08.** The child's turn genuinely COMPLETED (terminal `turn/end` with
`completed`) and its output is durable in its own Session before the kill. Note:
the child's live Agent is already gone by then, so the evidence is read from the
durable Session through a read handle — which is what recovery does anyway.
Recovery FINDS the completed turn and its output; the decision is `settling`,
never `confirmed`, and never a re-launch. With no result ref it is still
`settling`: the lost notice is a delivery problem, not a work problem.

**D09.** A real session log was damaged by appending an incomplete record with no
terminating newline, then resumed in a new generation. The torn record is not
returned to the reader, the synthetic seq never appears, the clean prefix is
byte-identical on disk afterwards, and no orphaned turn was invented. The repair
is DSH's own (`session-persistence-jsonl/src/storage.ts:324-331`); this project
has no repair path and does not erase the error fact — damage reconciles to
`unknown`. Separately: a schema-invalid stored record makes `open` reject with
`invalid-record` naming table and key, rather than being served as current.

**D10.** A settlement carrying an epoch that is not the record's is REFUSED —
the task does not move, nothing is confirmed, no tombstone is written, and the
reservation is still held — while the refusal is RETAINED durably in a separate
diagnostic domain and survives a reopen. A childId that is not the reserved one
is refused the same way. A settlement from the CURRENT epoch is applied, so the
guard is not a blanket refusal. **This gate found a real gap — see G2.**

**D11.** A second `open` of the same handle is refused promptly (bounded race, so
a hang fails rather than times out), and the FACILITY refuses a second handle for
the name with `already-open` while leaving the live handle intact. After `close`
the name is released and the record is intact. The unload/reload cycle is driven
through the REAL plugin entry point in a new host generation over the same
directory, and unloading frees the name again — so the cycle is repeatable.

**D13.** The run has no restart authorization and holds reserved credit. After a
real kill, recovery computes `paused` with a reason, APPLIES it as a real record
change (with its own outbox entry), and consumes nothing: `spent` 0,
`unknownReserved` 0, `reserved` unchanged at 5, the pending task still visible.
The paused run then REFUSES new admission, which is what makes the pause real
rather than cosmetic. Resume is a separate explicit edge. An expired
authorization — including one expiring exactly now — also comes back paused.

## Gaps found, stated rather than papered over

**G1 — D03 had no production relaunch path. FIXED in `src/recovery.ts` (new file).**

Reconciliation could return a task to `prepared`, but nothing could act on it.
`WorkService.drain` calls `admit`, and `admit` refuses a task that still holds
its slot (`task "..." is already admitted as prepared`); `prepared` IS
slot-holding (`states.ts:56-64`). So a reconciled `prepared` task was invisible
to the ordinary top-up path and would have sat there forever while the run
reported a capacity deficit. Asserted in the test as a fact, then resolved by
`relaunchPrepared`.

`src/recovery.ts` is a NEW file; I did not edit `host.ts`, `record.ts` or
`counting.ts`. It drives the EXISTING state machine through the EXISTING legal
transition and calls the EXISTING launch port. The exactly-once claim is the
STATE TRANSITION, not a lock: `transition` runs on the domain's single write
chain and `launching -> launching` is not a legal edge, so a concurrent recovery
loses at `assertTransition`. It is NOT exactly-once for external effects — a
crash between the claim and the launch is the D04 window and resolves to
`unknown`.

**G2 — D10's epoch field had no enforcement. FIXED in `src/recovery.ts` (new file).**

`record.ts:383-388` documents `epoch` as "bumped when a run is re-adopted by a
new host generation. A callback carrying a stale epoch must be rejected rather
than allowed to write authoritative state." No code read or wrote the field after
`initialRunRecord` set it to 1. My FIRST version of the D10 test hand-rolled the
comparison (`staleClaim.epoch === record.epoch`), which is tautological and would
have been a false green — it asserted my own arithmetic, not the system. It was
replaced with `applyWorkerSettlement`, which performs the real check.

The diagnostic evidence goes to a SEPARATE domain (`dsh_daily_work_refusals`)
rather than a field on the run record, because the two facts have opposite
authority: the run record decides what the system believes and what budget is
held, while a refusal only says a stale worker tried. Keeping them apart also
keeps the write paths apart, so recording a refusal can never take the run
record's write chain and cannot interleave with an admission.

## Cleanup

Every child process and temp directory is released. Two temp directories DID
leak during development, from `forkKillChild` throwing before its cleanup on a
failing run — fixed by moving the directory removal into a `finally`, and
verified afterwards: zero directories remain under any of this file's prefixes
(`dsh-daily-work-{durable-store,durable-sessions,durable-domain,d03,torn-sessions,invalid,reopen,plugin-reload,kill}-`).
`afterEach` also reaps any child still alive via SIGKILL and awaits its exit, so
a failing test cannot leave a live Node process holding a session directory.
`rmSync` uses `maxRetries` because Windows holds handles on session directories.

## Honest non-claims

- **D01's barrier.** The domain's atomicity is per record and the write chain is
  serialized; a genuine crash between two writes is not reachable because there
  is only one write. What the test proves is that there IS only one.
- **D09 is not a crash.** The damage is a real incomplete trailing record on a
  real artifact, produced by a real short write, but it was not produced by
  killing a process mid-write. The repair contract exercised is the same one.
- **D10's and D11's barriers.** Neither window is about what survived a kill.
  D10 is about what a second submission may do; D11 is about handle lifetime and
  a bounded refusal. Both are expressible directly, and a kill would add nothing.
- **SIGKILL proves survival, not fsync ordering.** On Windows the directory fsync
  is skipped by design (`storage-json/src/atomic.ts:44-52`), so these tests do not
  claim crash-durability of the directory entry.
- **Not exactly-once external effects anywhere.** The claims are about what the
  record is allowed to SAY after an interruption, which is the plan's actual
  requirement.
- **Two live writers on one directory is still unsupported.** D02 remains
  NOT_RUN; every reopen in this file disposes the previous generation first.
  Notably, `WorkService` now has a home-lock path (added by another agent) and
  `reopenOver` deliberately does not configure it, because this file's job is the
  record semantics, not the deployment boundary.
- **The whole-tree typecheck still reports 4 errors** in `control-plane.test.ts`
  and `tool-protocol.test.ts` (other agents' files). `src/recovery.ts` and
  `src/durability-records.test.ts` are clean under `tsconfig.check.json`, which
  includes tests — `tsconfig.json` excludes them and would be a false pass.
