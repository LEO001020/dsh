# RECOVERY — what survives a crash, and what must be reconciled

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
2. An old epoch is never reused. Stale callbacks are rejected when writing
   authoritative records.
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
There is an explicit persisted per-run "this run may continue after host restart"
authorization with a TTL. Without it, recovery comes back **paused** and shows
the pending work.

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

## Rollback

Rollback restores old artifacts **and** the old consistent state snapshot. State
that the new version already migrated must be accounted for. External effects
already produced by the new version are reconciled; rolling back software does
not undo a remote action. Cold backup or the official consistency export is
required — copying a live database file is not a consistent snapshot.
