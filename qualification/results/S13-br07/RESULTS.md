# S13 / BR-07 — end-of-cell drain: a recorded disposition per call, and the arms that are NOT reachable

Every number here was measured on THIS worktree's build
(`D:\DSH\work\wt-s13`), with `packages/dsh-ipython` compiled from this tree's
`src/` into this tree's `lib/` (`tsc -p tsconfig.json`, exit 0). The identity is
stated because this project filed two FALSE findings (G-SEAM-29, G-SEAM-36) by
measuring a stale `lib/`, and retracted both.

The oracle, verbatim from the v2 definition:

> Return a cell while native child calls are still in flight.

---

## 1. The four dispositions, with file:line and a reachability verdict

| disposition | decided at | what it means | PRODUCTION reachable? |
|---|---|---|---|
| `settled` | `bridge.ts:823` — `this.state === 'OPEN' ? 'settled' : 'cancelled'`, in `runOne` after the handler returned | the call finished while the lease was still open | **YES** — measured on a real boot |
| `cancelled` | same line, the other arm: the lease was `CLOSING`/`CLOSED` when the call returned | it was in flight when the cell settled and settled under the abort | **YES** — measured on a real boot |
| `abandoned-unstarted` | `bridge.ts:648`, in `settleQueuedCalls` when `this.handoffToJobs` is absent/returns undefined | accepted, never dispatched, refused at close | **YES** — measured on a real boot |
| `handed-to-jobs` | `bridge.ts:649`, the other arm of the same `if` | accepted, never dispatched, a host handoff took ownership and named a job | **NO — not reachable in any composition in this repository** |

### R5's rule for `settled` vs `cancelled`: CONFIRMED, and it is what the code does

`bridge.ts:816-819` states the rule and `bridge.ts:823` implements it. The
decision is `this.state === 'OPEN' ? 'settled' : 'cancelled'` — the LEASE's
lifecycle at the moment the call returned. It is **not** `outcome.ok` and not
"did the abort fire". The code's own reason is recorded at `bridge.ts:816-819`:
a tool can legitimately fail with its own error, and calling that `cancelled`
would misreport a real tool failure as a shutdown.

Before this slice that rule had **no test**. It now does, and it is
mutation-proven: inferring the disposition from `outcome.ok` turns the arm red
(`expected 'cancelled' to be 'settled'`).

### `handed-to-jobs`: REFUTED as reachable, and that is the honest answer

R5's limitation is CONFIRMED, by three independent facts rather than by reading
one comment:

1. The only producer is `KernelServiceConfig.jobHandoff`
   (`kernel-plugin.ts:201`), passed through at `kernel-plugin.ts:653`.
2. **No composition sets it.** `grep -rn jobHandoff --include=*.yml --include=*.yaml --include=*.json`
   over the whole repository (excluding `node_modules`) returns nothing, and the
   bundle patch that mounts the service (`packages/dsh-ipython/cordis.patch.yml`)
   does not mention it.
3. The `handed-to-jobs` **producer branch itself** (`bridge.ts:649`) had no test
   at all — R5's arm tested only the LEDGER's rule for the word. It has one now,
   driven by a lease with a handoff, and it is mutation-proven (forcing the branch
   to `undefined` turns it red).

**Verdict: acceptable, and more truthful than the alternative.** `handed-to-jobs`
is a host-configurable arm whose default is "refused", and the composition
records `abandoned-unstarted` instead — which is a true account of what happened.
A fabricated job id would name a job that does not exist, which is the failure
mode the oracle exists to prevent. The unreachability is therefore a recorded,
intentional limitation rather than the project's usual "mechanism exists and
nothing calls it" defect: the producer is optional BY CONTRACT
(`kernel-plugin.ts:193-200`), and the absent case has its own truthful arm.

---

## 2. The oracle reproduced on a real boot

`qualification/results/S13-br07/s13-br07-driver.mjs` boots the real `daily`
profile through the port-safe harness, and `s13-br07-probe.mjs` runs inside that
boot. The cell starts TWO background calls and returns without awaiting either;
the lease is serial (V3 §J1), so the first is dispatched and the second is queued.

```
presetDefaultId        daily-standard      (the profile's OWN default)
kernelServicePresent   true
ipythonToolPresent     true                toolCountAgentKey 29
bridgePresentAfterCell true                endpoint port 9012, protocol 1
kernelEpoch            1                   kernelLifecycle READY
toolCallOutcome        ok
cell stdout            RETURNING_WITH_A_IN_FLIGHT=True
                       RETURNING_WITH_B_IN_FLIGHT=True
registryDispatches     1  (s13_slow_inflight only)
slowEntered            1
queuedToolEntered      0                   <- the second call NEVER RAN
leasesAtRestAfter      0
```

The durable rows, read from the FILE (`D:\DSH\home\s13\storages\dsh_ipython_bridge_ledger.json`)
and cross-checked against the service's own ledger API (`apiAndFileAgree: true`):

| subCallId | tool | disposition | closeReason | startedAt | settledAt |
|---|---|---|---|---|---|
| `s13-br07-outer-1:ipython:1` | `s13_slow_inflight` | `cancelled` | `completed` | present | present |
| `s13-br07-outer-1:ipython:2` | `s13_queued_behind` | `abandoned-unstarted` | `completed` | present | **absent** |

Both calls carry ONE disposition, the second never ran, and the lease table is
empty afterwards: **nothing continued silently with no record**.

### Why R5's runner was not reused

`s13-br07-probe.mjs` is new, and the reason is recorded rather than assumed.
R5's `qualification/runners/r5-bridge-product.mjs` was read in full first; it does
not fit BR-07 for two measured reasons:

1. Its cell AWAITS its single `dsh.call` before returning, so the only
   disposition it can ever observe is `settled`. BR-07's stimulus is the opposite.
2. Its overlay `r5-bridge-product.patch.yml` hardcodes
   `D:/DSH/work/wt-r5/qualification/runners/r5-bridge-product.mjs` — a SIBLING
   worktree — and its driver's `OUT` default is that writer's results directory.
   Running it from this worktree would load another writer's module and write into
   another writer's tree, which is the stale/foreign-artifact trap behind
   G-SEAM-29 and G-SEAM-36.

My probe and driver derive every path from their own location and are under
`qualification/results/S13-br07/`. **R5's runner was not edited** (it is S15's to
sweep, and it was not run).

---

## 3. Two real defects found, both fixed and mutation-proven

### Defect 1 — a call that NEVER DISPATCHED was reported as the crash window

`unknownOutcomes()` filtered on `settledAt === undefined` alone, but the ONLY
writer of `settledAt` is `runOne` (`bridge.ts:809`), reached only when
`entry.started === true` (`bridge.ts:772`). A call that was accepted, never
dispatched, and disposed `abandoned-unstarted` therefore carried no stamp and was
returned as `OUTCOME_UNKNOWN` — whose stated meaning is that the effect is
unresolved.

MEASURED on the real boot BEFORE the fix: `unknownOutcomeCount: 1`, and the row
it counted was `s13_queued_behind`, whose own disposition is
`abandoned-unstarted` and which `queuedToolEntered: 0` proves never ran.

Why it matters: the crash window is the set a human reconciles against reality,
and the standing constraint is that an unknown effect is never auto-replayed.
Telling a reader that calls which provably never ran have unknown outcomes sends
them to reconcile effects that cannot exist, and dilutes the real window with the
ordinary BR-07 case.

Fixed in `3ab6ba2` by `outcomeIsUnknown()` (`bridge-ledger.ts`), one predicate
shared by both ledgers. The real crash window (no settlement, no disposition
proving it never ran) is unchanged. AFTER the fix, on the same boot:
`unknownOutcomeCount: 0`, while `unknownByNaiveSettledAtFilter` still lists
`s13-br07-outer-1:ipython:2` — the call the old predicate wrongly included.

### Defect 2 — a failed SETTLEMENT write hung the caller, the queue, and the close

`runOne`'s own docstring (`bridge.ts:781-784`) states: *"A THROW HERE MUST STILL
SETTLE THE CALLER ... a host-level failure (a ledger write, a bug) would otherwise
leave the accepted promise pending forever and hang the cell."* That was TRUE of
the handler and FALSE of the ledger write: the `try/catch` covered only
`this.handler`, so a rejected `ledger.settled` threw out of `runOne`,
`runQueue` never reached `entry.resolve` (`bridge.ts:774`), and the accepted
promise stayed pending forever.

MEASURED, fail-first, with an injected settlement failure — both arms red against
the pre-fix shape and green after:

| arm | pre-fix | post-fix |
|---|---|---|
| the caller | `HUNG` (not settled after 5 s) | `settled`, with the tool's own outcome |
| a call queued behind it | `HUNG` — never ran | both calls ran |
| `close()` | hung (its drain awaits in-flight promises) | returns, and reports the loss |

So one unwritable settlement turned a cell's entire bridge into a hang.

Fixed in `c90acb6`. On failure NO disposition is reported, deliberately: because
`outcomeIsUnknown` keys on the disposition, a disposition would HIDE the row from
`unknownOutcomes()` — the one place a reader looks for an outcome that was never
established. The row stays STARTED with neither stamp, and the loss is reported
through the same `BridgeLedgerWriteError` channel the disposition-write failure
already used, so "is this close's record complete?" has one answer covering both
halves of the record.

---

## 4. Is the ledger durable and honest?

- **Durable: YES, proven against the FILE.** The boot's rows were read twice —
  through the service's ledger API and by parsing
  `D:\DSH\home\s13\storages\dsh_ipython_bridge_ledger.json` — and the two agree
  (`apiAndFileAgree: true`). Reading it back only through the writer's own object
  would not have tested durability. R5's `RESULTS.md` measured this too; this is
  an independent confirmation, not a citation.
- **A failed DISPOSITION write is REPORTED, not swallowed.** R5's
  `BridgeLedgerWriteError` fix is real, and it is **mutation-proven here**:
  reintroducing the pre-fix bare `Promise.allSettled` (discarding rejections) in
  `flush` makes the fault arm red (`expected undefined to be defined` — the close
  reported nothing while reaching CLOSED). Restored, and the arm is green. The
  healthy-contrast arm passes, so the error is a real signal rather than an
  always-on one.
- **A failed SETTLEMENT write is now reported too** — see Defect 2. Before this
  slice it was not reported at all; it hung.
- **No custom Session event and no second database.** The ledger is a DSH
  storage-domain over the same JSON backend the profile mounts (V3 §J5.14), and
  the boot confirms it lands in the profile's own `storages/` directory.

## 5. The crash window

The claim is CONFIRMED, at three levels:

1. **Ordering.** `bridge.ts:551` awaits the durable `STARTED` write at ACCEPTANCE,
   before `scheduleDrain()` and before any dispatch, so the intent row is durable
   before a mutating call can run.
2. **No replay primitive exists.** The ledger's whole surface is
   `started / settled / disposed / get / forOuterCall / forSession /
   unknownOutcomes / all`. It imports nothing that can dispatch: `grep` for
   `tools.execute` in `bridge-ledger.ts` returns nothing, and `kernel-plugin.ts`
   never reads the ledger back for replay.
3. **A second attempt does NOT re-send — measured across a real domain reopen.**
   The new arm dispatches a call through a real `CellLease` over the real storage
   domain (`storage` hub -> `json` backend -> `domain` facility, the same three
   rows the base bundle mounts), leaves the lease unclosed so no settlement is
   written, then reopens the domain over the same directory as a second process
   would. Reopening is the moment a host would auto-replay an unknown effect, so
   that is where it is measured: the unknown row is still readable with its
   `argsDigest` and no settlement, it carries NO disposition (which is what
   distinguishes it from the abandoned call), and the dispatch counter is
   unchanged. Mutation-proven: forcing `outcomeIsUnknown()` to `false` turns the
   arm red.
   A reconciliation CAN still settle the row later, and the arm asserts that, so
   it cannot pass by the ledger being unwritable.

## 6. The restart arm — PASSES, but R5's remedy does NOT remove the variance

`packages/dsh-ipython/src/r5-restart-epoch.test.ts`, run ALONE in a fresh process
in this tree, four times on the same commit with no source change between runs:

| run | result | test time | suite duration | wall |
|---|---|---|---|---|
| 1 | PASS | 5589 ms | 6.39 s | 6960 ms |
| 2 | **FAIL** | **63710 ms** | 64.30 s | 64749 ms |
| 3 | PASS | 5150 ms | 5.81 s | (not recorded) |
| 4 | PASS | 4875 ms | 5.56 s | 6029 ms |

Run 2 failed with the same shape R5 recorded:
`KernelTransportError: BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds`.

**This corrects a claim in R5's own file header.** R5 moved the arm to its own
process "where the product property it measures is deterministic"
(`r5-restart-epoch.test.ts:20-24`). It is not: the failure reproduces in a FRESH
PROCESS BOOTING ONE KERNEL, which falsifies the "20th arm of a long file"
explanation. The rate is now measured rather than unknown: **1 failure in 4
isolated runs**, ~12x the healthy time, in G-SEAM-36's family.

The CAUSE is still NOT isolated, and no replacement theory is offered — the arm
failed in isolation, which is exactly the configuration a load hypothesis says
should be safe, so that tension is left open rather than guessed at. Per
instruction the arm was NOT retried until green, NOT widened, NOT deleted, its
timeout was NOT raised, and no fix was attempted. Full record:
`restart-arm-variance.txt`.

The PRODUCT property the arm asserts (epoch advances, capability identity rotates,
no lease survives) held in every run that reached it; run 2 failed on the restart
TRANSPORT before asserting anything. So the property is measured, and its
measurement is flaky at roughly 1-in-4 on this machine — which is why four runs
are reported instead of the one green run I could have quoted.

---

## 7. Test files run (one at a time, per the brief's CPU rule)

| file | result |
|---|---|
| `r5-product-bridge.test.ts` | **30/30 passed** (was 24/24 before this slice; 6 arms added) |
| `r5-restart-epoch.test.ts` (isolated, 4 runs) | 3 PASS / **1 FAIL** — see §6 |
| `node helpers/typecheck.mjs` | exit 0, 2 packages, tests INCLUDED (F10 gate) |
| `tsc -p tsconfig.json` (the build into `lib/`) | exit 0 |

The full suite was NOT run: the brief forbids it, and every file touched is above.

## 8. What is NOT measured

- **No real model turn.** There is no LLM in the composition boot; the probe calls
  `ctx.tools.execute` with the `ipython` tool's own name, which is what the agent
  loop does, but the model's decision to call the tool is not exercised.
  `live_provider_budget_authorized: false` on this deployment.
- **`handed-to-jobs` was NOT measured on a real boot**, because no composition in
  this repository configures it (see §1). It is measured at the lease level with a
  handoff installed, and mutation-proven.
- **The two nested tools are the PROBE's**, registered through the boot's real
  registry. Registering a tool is what the deployment does; these stand in for the
  catalog and are not a claim about which tools it holds.
- **Exactly-once external effects are NOT proven** and are not claimed. The ledger
  records occurrence and outcome; it cannot make a non-idempotent effect exactly
  once.
- **The durable write is proven against the JSON backend only.** A different
  storage backend is untested.
