# P3 / P0.4 — CellLease: STARTED-ledger ghost state and the `pending` double-count

Reconnaissance recorded BEFORE the edits, so the before/after pair is on disk
(V3 §7: "Archive the OLD reproduction BEFORE you change the behaviour").

Worktree `D:\DSH\work\wt-p3`, branch `wt/p3`, based on `2e1b2c2`.

## What I read, and where

Both defects re-verified by reading the current tree, not taken from the dispatch.

### DEFECT 1 — accepted state is published before the durable STARTED is known

`packages/dsh-ipython/src/bridge.ts`, `CellLease.invoke`, lines 536-564 at `2e1b2c2`:

```
:540  const settled = new Promise<NativeCallOutcome>((res, rej) => { resolve = res; reject = rej })
:541  const accepted: AcceptedCall = { call, subCallId, sequence: this.sequence, ... }
:542  this.byRequestId.set(call.requestId, { subCallId, name: call.tool, argsDigest: digest.digest, settled })
:543  this.queue.push(accepted)
:544  this.inFlight.add(settled)
:545  void settled.catch(() => undefined).finally(() => { this.inFlight.delete(settled) })
:551  await this.ledger.started({ ... })      <- can throw
:563  this.scheduleDrain()
:564  return await settled
```

`await this.ledger.started(...)` is the first suspension point after publication.
`StorageBridgeLedger.started` is `await this.table.put(...)`
(`bridge-ledger.ts:367-369`), which is a real durable write and can reject; a test
stub can reject too. If it rejects, `invoke` rejects to its caller
(`BridgeServer.onCall` at `bridge.ts:1184-1204` turns a non-`LeaseRejection` into a
`BRIDGE_FAILED` result frame), while all three collections already hold the call:

- `byRequestId` — a duplicate `requestId` finds `previous` at `:520` and joins
  `previous.settled` (`:527`). That promise is never resolved and never rejected:
  `runQueue` never sees the entry because `scheduleDrain()` at `:563` is never
  reached. The duplicate hangs forever rather than failing.
- `queue` — `settleQueuedCalls` at close will reject the entry, which is the one
  arm that eventually disposes of it.
- `inFlight` — the entry keeps `inFlight.size > 0`, so `drain` (`:604-608`) waits
  on a promise that only the close path itself will settle.

So the caller is told the request failed while the lease holds an accepted call
that never executed.

### DEFECT 2 — `pending` double-counts

`packages/dsh-ipython/src/bridge.ts:475-478` at `2e1b2c2`:

```ts
/** How many accepted calls have not reached a terminal state. */
get pending(): number {
  return this.inFlight.size + this.queue.length
}
```

`inFlight.add(settled)` at `:544` runs for EVERY accepted call, at publication.
`queue.push(accepted)` at `:543` runs for the same call. A call that has not
started is therefore in BOTH collections and is counted TWICE. `inFlight` is the
complete set (populated at `:544`, removed at `:545` when the promise settles), so
it is the correct single count. V5 §6.3 states the rule directly: "Return one
count per accepted unsettled logical call. If `inFlight` already includes queued
calls: `pending = inFlight.size`."

No production consumer of `CellLease.pending` was found (`grep` over
`packages/*/src` excluding tests). This is therefore an observability-correctness
fix, not a fix to a caller that was visibly misbehaving — stated so that a reader
does not over-read the change.

## Which option, and why (V5 §6.2)

Chosen: **Option A** — provisional accepting map, `await ledger.started`, then
publish into `byRequestId` / `queue` / `inFlight`.

The argument that decides it is not "A is cleaner". It is that **Option B's
rollback can fire after the call has already been dispatched**, because of how the
FIFO interacts with concurrent `invoke` calls. Under B the entry is in `queue` at
`:543` before `ledger.started` is awaited, and a DIFFERENT concurrent `invoke` that
finishes its own ledger write reaches `scheduleDrain()` (`:563`) and `runQueue`
shifts the first entry off the queue and runs `this.handler(...)` -> a real
`ctx.tools.execute`. If that first entry's own `ledger.started` then rejects, B's
rollback removes it from `byRequestId`/`queue`/`inFlight` — but it has already
executed a mutating tool call, and it is now absent from every structure the
ledger's crash window is keyed on. B therefore trades a ghost for something worse:
an executed side effect with no record. A has no such window, because the entry is
not reachable by `runQueue` until after the durable write resolved.

Full reasoning and the duplicate-during-in-flight rule are recorded in the commit
that implements A.

## Evidence index (filled in as the work lands)

| item | path |
|---|---|
| this recon note | `qualification/results/P3-lease/RECON.md` |
| fault-injection test | `packages/dsh-ipython/src/p3-lease-started.test.ts` |
| test output | `qualification/results/P3-lease/tests.txt` |
