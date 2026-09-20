# RECOVERY — what survives a crash, and what must be reconciled

> **Reachability caveat on everything below.** This document describes recovering
> a **run**. `WorkService.createRun` has no production caller (G-SEAM-31,
> measured: `qualification/results/ROOT-verification/work-tool.json` with a
> positive control), so a run cannot be created by any user action on the
> composed profile. Recovery of a managed run is therefore **not exercisable
> end to end today**, and every recovery claim below is a statement about the
> mechanism rather than about the product. The reconciliation path is
> additionally unreachable on its own terms: `recovery.ts` and `reconcile.ts`
> have no production importer. The measurements are real; the reachability is
> not.
>
> **A third mechanism this caveat used to list — the epoch guard at step 2 — no
> longer exists.** It was **deleted rather than wired** (F8 / REC-09 / REC-10;
> `qualification/results/R9-recovery-topology/`), and step 2 below now records
> what IS enforced in its place. It is listed here rather than silently dropped
> because a removed claim and a claim that was never made must not look alike.

## The five positions are not the same event

```
1. task intent durably admitted        (our run record)
2. child Session / Inbox accepted      (DSH native)
3. Inbox claimed                       (DSH native)
4. message entered a real model request (DSH native / provider)
5. task effect or result confirmed     (real world / artifact)
```

A crash can happen between any two. They are tracked separately (INV-D3). We do
**not** copy DSH's Session. The native Session stays the record of what happened;
our plugin state stores only assignment, permission, resource reservation and
pending-reconciliation relations.

## Admission record states

Mechanical operation states — not Planner/Reviewer cognitive stages:

```
prepared → launching → accepted → executing → settling → confirmed
                                    ↘ cancel_requested → cancelled
                                    ↘ unknown (quarantined)
```

States may be merged by type in an implementation, but test coverage must not be.

## Recovery procedure

1. Verify **deployment identity**, `schemaVersion`, and whether the old process
   can still produce effects.
2. **An old epoch is never reused — and there is no longer an epoch to reuse.**
   This step used to describe a real, tested guard (`applyWorkerSettlement` in
   `recovery.ts`) that refused a stale-epoch settlement but was unreachable from
   any production path. The topology measurement closed that question in the
   other direction: **the guard, its `WorkerSettlement` type, its
   `RefusalLedger` over the separate `dsh_daily_work_refusals` domain, and the
   run record's `epoch` field were all DELETED rather than wired**, because
   wiring them would have meant inventing a cross-process settlement producer
   (`recovery.ts:188-255` states the measurement; `record.ts:410-441` states the
   schema decision). The reason is sharper than unreachability: **no production
   call site targets a terminal task state**, and the state the product actually
   leaves an unsettled task in — `unknown`, with its reservation held — has no
   production exit (`host.ts:2232-2238` and `host.ts:2261-2267` write `unknown`
   with `releaseReservation: false`; `admit` refuses a slot-holding task,
   `host.ts:1442-1450`; `relaunchPrepared` refuses anything not `prepared`,
   `recovery.ts:103-113`). A settlement is the act of LEAVING an in-flight
   state, and that write has no production call site in any generation, stale or
   current. **What IS enforced instead is object identity**
   (`tool-protocol-guards.ts` compares the calling Agent against the live
   registry by OBJECT, `ctx.agents.get(id) === owner`), which covers the
   in-process resume case — a case the product can reach. A run re-adopted
   across a **process** boundary has no generation fencing, and **v2 does not
   claim it**: the v1 cases REC-09 and REC-10 stay FAIL historically, and the
   mechanism is recorded as a NON-CLAIM rather than as a fix.
   (`docs/DELETE-AUDIT.md` §3.8.1 records the earlier, wider claim and its
   correction; `record.ts:410-441` now says so in the schema itself.)
3. For every reserved `childId`, query the existing Session / descriptor / Inbox
   / actual request and result.
4. Pending input that never entered a request is recovered by **DSH natively**;
   we do not duplicate it.
5. After claim with no request confirmation, or after a request/side effect with
   no result: mark `unknown`/`reconcile`. **Do not blindly dispatch a new child.**
6. A lost result notification can be recovered from the child's persistent
   Session. The parent not receiving a message is **not** a child failure.
7. `interrupted`, `lost reply`, and `disposal error` are never automatically
   treated as safe to redo.

## Shutdown order (measured, not assumed)

The N=10 concurrency suite hung for 60 seconds per test until this order was
found. It is worth stating precisely because the naive order deadlocks:

```
1. release any gate holding in-flight model calls
2. close the work service        -> refuse new admissions, release the domain
3. drainContinuableDescendants   -> stop the children
4. dispose persistence, then the context
```

**Why the naive order hangs.** A child parked inside a model call cannot be torn
down. Disposing the context fiber waits for the child's driver to exit, and that
driver is waiting on the model call. So "dispose first, clean up after" waits
forever on work that cannot finish.

Step 1 is a test concern (the gate is the test's own invention), but steps 2–4 are
the production sequence: refuse new work, then stop owned work, then release
storage, then unwind the context. Note that step 3 uses
`drainContinuableDescendants`, which closes admission for that exact parent — it
is the final-close operation, which is why a *pause* never uses it.

## Authorization on restart

Reopening a Session does **not** re-authorize unbounded background execution.
There is an explicit persisted per-run flag, `restartResumeAuthorized` on the run
record (`record.ts`), and it defaults to **false** (`host.ts` writes
`input.restartResumeAuthorized ?? false`). Without it, recovery comes back
**paused** and shows the pending work. An earlier revision of this file described
this as "an authorization with a TTL"; **there is no TTL in the implementation** —
the field is a boolean, and nothing expires it. Stated precisely because a TTL
implies a time-based guarantee this code does not make.

## Rollback

Rollback restores old artifacts **and** the old consistent state snapshot. State
that the new version already migrated must be accounted for. External effects
already produced by the new version are reconciled **before** the rewind — the
local ledger that names the operations may refuse to open once the state is
rewound, which is why the reconciliation cannot wait. Rolling back software does
not undo a remote action. Cold backup or the official consistency export is
required — copying a live database file is not a consistent snapshot.

**A concrete, checkable sequence is in `docs/DELIVERY.md` §12.** **Honesty
marker:** the rollback has been **rehearsed, not exercised** — no real newer
version has ever been rolled back, because no version has been promoted. The
rehearsal is `qualification/results/R4-upgrade/u06-rollback-rerun.json` over a
temp home, with a fixture for the newer version and an in-process fake for the
remote, and its `notClaimed` array says exactly that.

## Quarantine

The current subagent activation teardown has a path that catches flush/dispose
errors, warns, and continues releasing. Therefore `subagent/end` must be
reconciled together with error state and live/owned resources before a slot is
returned. A safe `unknown` holds conservative quota until reconciled. Loss of
heartbeat is **not** evidence that no residual process exists.

## Durability facts we rely on (to be re-verified locally)

- DSH has durable `agent/inbox/spliced` and pending Inbox can be restored from
  the log.
- The storage domain is an **in-process cache plus serialized writes** — not a
  cross-process CAS. External workers never write the same domain directly, and
  two hosts never share a state directory that assumes a single writer.
- Migrations are not automatic. A schema version change needs offline conversion
  or a new namespace with an explicit cutover. An un-migratable schema refuses to
  start rather than silently reading an old backup and calling it current.
