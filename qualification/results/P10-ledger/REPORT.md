# P10 — P1.3 DURABLE BRIDGE LEDGER: BEFORE/AFTER AND EVIDENCE INDEX

Slice P1.3. Worktree `D:\DSH\work\wt-p10`, branch `wt/p10`.
Identity measured under: this worktree's own `packages/*/lib/`, rebuilt by
`node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json` in each
package AFTER the edit and BEFORE the composition-tier run. The stale-`lib` trap
(G-SEAM-29/36) was checked explicitly: before rebuilding, `lib/kernel-plugin.js`
still contained the OLD `?? new MemoryBridgeLedger()` fallback.

---

## THE HEADLINE, BEFORE AND AFTER

**BEFORE.** A configuration that requested a durable ledger and could not open one
silently ran on an in-memory ledger. Two lines did it:

- `packages/dsh-ipython/src/kernel-plugin.ts:535` —
  `.catch(() => undefined)` swallowed every open failure;
- `:540` — `opened?.ledger ?? new MemoryBridgeLedger()` substituted memory.

The caller believed durability was requested; the kernel published READY anyway.

**AND IT WAS NOT CONDITIONAL ON STORAGE FAILING.** Measured, and this is the part
V5's framing does not say: the failure was ROUTINE. `openBridgeLedger` is called
once per new Session, and `DomainFacility.open` refuses a domain name that is
already open (`@deepseek-ai/dsh-storage-domain`, `src/index.ts:103-106`,
`DomainError('already-open')`). So the SECOND kernel published in any process —
two Sessions in one host, ordinary product use — hit `already-open`, had it
swallowed, and fell back to memory. First Session durable, second silently not.

**AFTER.** A configuration that requests durability and cannot obtain it
**refuses READY**, loudly, naming the ledger and the cause. Only an explicit
`durableLedger: false` gets an in-memory ledger, and the status surface reports
which one was actually obtained.

---

## BEFORE EVIDENCE (the archived red run)

`qualification/results/P10-ledger/BEFORE-test-run.txt` — 4 of 6 arms RED:

```
 × ...refuses when the deployment has NO storage facility and durability was not opted out of
 × ...refuses when the storage facility is present but the ledger domain cannot open
 × ...refuses without publishing READY: no kernel, no bridge, and no entry left behind
 ✓ ...runs a cell with durableLedger: false and reports non-durability rather than claiming it
 ✓ ...runs a cell on the durable default and reports durability, with no opt-out needed
 × ...gives a SECOND session in the same process a durable ledger too
```

The third red arm's diff is the defect in one picture: the gate expected a thrown
refusal and RECEIVED a complete successful `CellResult` (`outcome: "ok"`) — a
kernel that ran, on a memory ledger, for a configuration that asked for durable.

The sixth arm is the routine-degradation measurement: with a real storage domain
mounted, session 1 reported durable and session 2 reported NOT durable.

## AFTER EVIDENCE

`packages/dsh-ipython/src/p10-ledger-durable.test.ts` — **8/8 pass**, including the
control arm that proves the durable default still works (so the fix is not "always
refuse") and the contrast arm that proves `bridgeLedgerDurable: false` is reported
for the explicit development host (so the field is not hardcoded `true`).

`qualification/results/P10-ledger/verdict.json` — the composition tier, two arms
against a REAL `daily` boot through the port-safe harness:

```
P10 POSITIVE: {"serviceResolved":true,"storageDomainPresent":true,"cellRan":true,
               "ledgerIsDurable":true,"bridgeLedgerDurableOnStatus":true}
P10 NEGATIVE: {"probeRan":true,"cellRefused":true,"refusalNamesLedger":true,
               "noKernelPublished":true}
```

The negative arm's refusal text, read out of the boot:

```
outcome: transport_failure
the durable bridge ledger was requested but could not be opened, so this kernel is
refused: ... Cause: domain 'dsh_ipython_bridge_ledger' is already open
```

## MUTATION EVIDENCE (the gate broken on purpose)

`qualification/results/P10-ledger/MUTATION-2-no-memoisation.txt`. Two mutations,
each breaking ONE of the two fixes:

| mutation | expected | measured |
|---|---|---|
| restore the original `.catch(() => undefined)` fallback | refusal arms red | **3 red** (all three refusal arms), 5 green |
| remove the per-facility memoisation only | second-session arm red | **1 red** (the second-session arm), 7 green |

The second mutation is the interesting one: it shows the memoisation is
independently load-bearing, and the failure mode it produces is exactly the one
the coordinator predicted — the second Session does not silently degrade, it
REFUSES READY, with `Cause: domain 'dsh_ipython_bridge_ledger' is already open`.
That is why the fix needed both halves and not only the requirement.

Both files were restored from backup afterwards and the gate re-run green (8/8)
with `git status` clean for `src/`.

---

## WHAT I DID NOT ESTABLISH

1. **A durable JSON ledger is not a crash-proof one.** The ledger is written
   through the storage domain's write chain, which `put` resolves only after the
   backend accepted the row — that is an ordering claim, not a durability claim
   against power loss, an OS-level write cache, or a torn write.
2. **I did not test a real power loss, process kill, or torn write.** The
   crash-window arms model a crash by ABANDONMENT (a call left pending), which is
   the observable half of "the process died"; no arm kills a process mid-write.
3. **I did not establish the cause of one dead end.** Routing only the ledger
   domain at a missing backend (a `storage-domain` patch supplying only `config`)
   left the whole `storage-domain` row unactivated and eight rows pending. Cause
   NOT established; recorded as an UNRESOLVED UNKNOWN rather than explained away.
   The instrument was replaced with one that is precise about its stimulus.
4. **The composition tier does not drive a model turn.** No LLM is authorized in
   this deployment, so the probe calls `ctx.tools.execute` with the `ipython`
   tool's own arguments, which is what the agent loop does — but the model's
   decision to call the tool is not exercised.
5. **The `already-open` contention is fixed by sharing one ledger per facility.**
   That makes the ledger process-scoped rather than Session-scoped. I verified
   rows carry `sessionId` and that `forSession` filters by it, so the table is
   keyed correctly for sharing; I did NOT measure two Sessions' rows interleaving
   under concurrent load.

## A NOTE ON `ledgerDurable` — THE INERT FIELD

`ledgerDurable` (`kernel-plugin.ts:541`) recorded the truth all along, and
**nothing in production read it**. Its only two consumers in the whole repository
were qualification probes that wrote it into a JSON artifact
(`qualification/runners/r5-bridge-product.mjs:214`,
`qualification/results/S13-br07/s13-br07-probe.mjs:263`). No code refused,
retried, or warned on it. That is the "mechanism with no consumer" class this
project records repeatedly, and it is why the silent degradation survived: the
one signal that would have made it visible was computed, stored, exposed — and
inert. The fix is not that the field became truthful (it already was); it is that
the truth became load-bearing, and now reaches a surface a doctor reads.
