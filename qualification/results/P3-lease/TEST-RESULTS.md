# BRI-STARTED-ROLLBACK and BRI-PENDING — measured results

Slice P3 / P0.4. Worktree `D:\DSH\work\wt-p3`, branch `wt/p3`.
All commands run from `packages/dsh-ipython` (ONE test file at a time; never the
whole suite — round-3 brief §4).

Test file: `packages/dsh-ipython/src/p3-lease-started.test.ts` (10 arms).

## 1. Green run

```
node node_modules/vitest/vitest.mjs run src/p3-lease-started.test.ts
```

```
 ✓ BRI-STARTED-ROLLBACK > the call is refused as LEASE_LEDGER_UNAVAILABLE, nothing is dispatched, and close() reaches CLOSED promptly
 ✓ BRI-STARTED-ROLLBACK > the same fixture with a healthy ledger dispatches once and settles (the control)
 ✓ BRI-STARTED-ROLLBACK > a duplicate arriving WHILE the write is in flight joins it: one write, one dispatch, one shared answer
 ✓ BRI-STARTED-ROLLBACK > the same duplicate during a FAILING write gets the SAME structured refusal, and neither caller hangs
 ✓ BRI-STARTED-ROLLBACK > a CONFLICTING requestId during the in-flight write is refused as REQUEST_ID_CONFLICT
 ✓ BRI-STARTED-ROLLBACK > the same requestId retried AFTER the refusal is a clean retry: one dispatch, one row, no replay
 ✓ BRI-STARTED-ROLLBACK > a close during the in-flight write disposes the call with a recorded disposition, and CLOSED is still reached
 ✓ BRI-PENDING > one running call plus one queued call reports 2, which is where the two readings differ
 ✓ BRI-PENDING > a queued call alone is 1, not 2, and the count tracks settlement
 ✓ BRI-PENDING > a call whose STARTED write is still in flight is NOT counted, because under Option A it is not accepted yet

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

## 2. MUTATION TEST OF THE `pending` GATE

A passing test I did not watch fail is not evidence (round-2 brief §3.5). The
production getter was reverted to the old expression, `src/bridge.ts` was not
otherwise touched, and the file was re-run.

Mutation applied: `return this.inFlight.size` -> `return this.inFlight.size + this.queue.length`

```
× BRI-PENDING > one running call plus one queued call reports 2, which is where the two readings differ
  -> expected 3 to be 2 // Object.is equality

 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

`expected 3 to be 2` is the double-count itself, measured: two logical calls
(one running, one queued) were counted as three. The three other BRI-PENDING /
BRI-STARTED arms stayed green, so this assertion is the one that discriminates
the two readings rather than merely agreeing with the fix.

Note: the mutation arm above is the one that FAILS. The two other BRI-PENDING
arms pass under the mutation too, because a single-call lease has
`queue.length === 0` at the moment it is observed. That is stated so a reader
does not take "9 passed" as evidence the other arms discriminate.

## 3. MUTATION TEST OF THE STARTED GATE

Mutation applied: publication moved back before the durable write, i.e. the
original defect shape —

```
+    this.publish(call, accepted, settled)
     const acceptance = (async () => {
       await this.ledger.started({ ... })
```

```
× BRI-STARTED-ROLLBACK > the call is refused as LEASE_LEDGER_UNAVAILABLE, nothing is dispatched, and close() reaches CLOSED promptly
  -> expected [ 'p3_probe' ] to have a length of +0 but got 1
× BRI-STARTED-ROLLBACK > the same fixture with a healthy ledger dispatches once and settles
  -> expected [ 'p3_probe', 'p3_probe' ] to deeply equal [ 'p3_probe' ]
× BRI-STARTED-ROLLBACK > a duplicate arriving WHILE the write is in flight joins it
  -> expected 1 to be +0
× BRI-STARTED-ROLLBACK > the same duplicate during a FAILING write gets the SAME structured refusal
  -> expected 'RESOLVED' to be 'LEASE_LEDGER_UNAVAILABLE'
× BRI-STARTED-ROLLBACK > a CONFLICTING requestId during the in-flight write is refused as REQUEST_ID_CONFLICT
  -> expected [ 'p3_probe', 'p3_probe' ] to deeply equal [ 'p3_probe' ]
× BRI-STARTED-ROLLBACK > the same requestId retried AFTER the refusal is a clean retry
  -> expected [ 'p3_probe' ] to have a length of +0 but got 1
× BRI-STARTED-ROLLBACK > a close during the in-flight write disposes the call with a recorded disposition
  -> expected 'RESOLVED' to be 'CELL_LEASE_EXPIRED'
× BRI-PENDING > one running call plus one queued call reports 2
  -> ... closed but 2 disposition(s) could not be recorded durably: ... already carries disposition settled; a call reports exactly one
× BRI-PENDING > a queued call alone is 1, not 2
  -> ... closed but 1 disposition(s) could not be recorded durably: ... already carries disposition settled
× BRI-PENDING > a call whose STARTED write is still in flight is NOT counted
  -> expected 1 to be +0

 Test Files  1 failed (1)
      Tests  10 failed (10)
```

**THE FIRST LINE OF THAT OUTPUT IS THE ARGUMENT FOR OPTION A, MEASURED.**
`expected [ 'p3_probe' ] to have a length of +0 but got 1` means: with
publication before the write, a call whose durable `STARTED` write FAILED still
reached `ctx.tools.execute` and ran the tool body. That is the exact hazard that
makes Option B unsound on this FIFO rather than merely less tidy — a rollback
that fires after the dispatch removes the record of an effect that already
happened. The reasoning is in `CellLease.accepting` and the commit message; this
run is what shows it is not hypothetical.

Restoration was verified by hash, not by eye:

```
sha256(bridge.ts before mutation) = d67fb583108ed528ec944635fe470fb6fa3fd204b02e1c7ff7ad83c6696ffa98
sha256(bridge.ts after restore)   = d67fb583108ed528ec944635fe470fb6fa3fd204b02e1c7ff7ad83c6696ffa98
```

## 4. Regression runs (one file at a time)

```
node node_modules/vitest/vitest.mjs run src/r5-product-bridge.test.ts  ->  1 passed (30 tests)
node node_modules/vitest/vitest.mjs run src/bridge-seam.test.ts        ->  1 passed (17 tests)
node node_modules/vitest/vitest.mjs run src/v3-spec-gates.test.ts      ->  1 passed (12 tests)
```

These are the three files that exercise the lease, the bridge and the spec
gates most directly. `r5-product-bridge.test.ts` contains the existing
disposition / handoff / crash-window arms, so it is the one that would catch a
regression in the disposal path this slice refactored
(`disposeUnstarted` extracted from `settleQueuedCalls`).

## 5. Typecheck

```
node D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json
-> (no output)
```

`tsconfig.check.json` is the config that INCLUDES `src/**/*.test.ts` (F10/F11),
so this covers the new test file as well as the production change.
