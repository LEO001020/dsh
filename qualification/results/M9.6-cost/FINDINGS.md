# M9.6 — cost and accounting gates: C05, C11, R06

**Status: all three gates CLOSED at the record/arithmetic level, with the
live-provider half of each explicitly NOT_RUN.** No provider is authorized, so
every number here is a controlled input chosen by a test, not an observation of
a real bill. That distinction is the first section below and it is not softened
anywhere else in this file.

Evidence in this directory:

| file | what it is |
| --- | --- |
| `tests.txt` | real `vitest run src/cost.test.ts` output, 43 passed / 0 failed |
| `tsc.txt` | two typechecks: production sources (`tsc_prod_exit=0`) and all of `src/**` including tests (`tsc_all_exit=2`, 0 errors in `cost.test.ts`) |
| `source-digests.txt` | sha256 of every file this case touches |
| `sabotage.txt` | four mutations, each shown to make the suite fail, with a restored-source control |
| `FINDINGS.md` | this file |

Run it yourself:

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/cost.test.ts
```

---

## What is proven, and what is not

**Proven (controlled inputs, real storage domain, real record schema, real
state machine):**

- a child admission that would consume the root's reserve is REFUSED, and the
  refusal is reported with the arithmetic that produced it;
- an actual spend above its reservation is recorded IN FULL, its excess is
  recorded separately, and new admissions stop until a human resolves it;
- a request whose usage never arrived keeps a conservative reservation and is
  never zeroed;
- a retry is a separate billed attempt, and a request id reused across attempts
  is not summed twice.

**NOT proven, and not claimed:**

- that a real provider's bill matches the reservation. C05's stimulus is
  "child uses up its provider connection quota" and C11's is "actual usage
  exceeds the reservation". Neither can be produced without an authorized
  provider, so the **provider-quota half of C05 and the real-billing half of
  C11 remain NOT_RUN.** What is closed is the record's behaviour once such an
  event is reported to it.
- that the reserved amount is a good *estimate*. The code cannot know that; it
  can only refuse to hide the error when the estimate is wrong.

---

## C05 — root credit reservation: CLOSED (arithmetic), NOT_RUN (provider quota)

### The invariant added

> **For every reachable state of a run,
> `budget.spent + budget.reserved + budget.unknownReserved
>  <= budget.ceiling - budget.rootReserve`.
> The root therefore always retains at least
> `rootReserve - rootSpent` of its own credit, regardless of how many children
> were admitted.**

That is the sentence in `record.ts` as the comment on `budgetSchema`, and it is
the thing the tests check. It is mechanical because `rootReserve` is carved out
of the ceiling AT RUN CREATION (`createRun`), not added beside it: a reserve
that were an addition would authorize more than the user granted.

### How it is enforced

One subtraction, in one place — `childCeiling(budget) = ceiling - rootReserve`
in `record.ts` — read by both `mayAdmit` (the gate) and `explainDeficit` (the
reported reason). The single definition is deliberate: two copies of the
arithmetic is how a gate and its stated reason drift apart, and this file's own
header warns about exactly that.

`spendRoot` is the other half, and it is what makes the reserve a real budget
rather than a number that is never used: a root spend draws on
`rootReserve - rootSpent` and touches none of `spent`, `reserved` or
`unknownReserved`. The two budgets are disjoint in both directions, and there is
a test for each direction.

### The C05 test, at its boundary

Ceiling 100, reserve 10, so the child ceiling is 90. A child asking for 91 is
refused with the reason naming all four numbers:

```
no budget headroom (committed 0, child ceiling 90, root reserve 10 of ceiling 100)
```

and the same request is refused through the drain path, where the reported
reason is asserted to be `budget_blocked` — the ADMISSION PREDICATE's own
answer, not merely "it did not work".

---

## C11 — spend exceeds reservation: CLOSED (arithmetic), NOT_RUN (live billing)

The case is literal: reserve 1, report actual spend 3.

- `budget.spent` becomes 3 — the full amount. Nothing is clamped to the
  reservation.
- `budget.overage` becomes 2, and it is a PART of `spent`, not an addition to
  it. Adding them would double the bill; there is a test pinning that.
- `budget.halt` is set, with the numbers in the reason string:
  `actual spend 3 exceeded the reservation 1 made for this work by 2`.
- `mayAdmit` refuses further admission, both through `admit` and through
  `drain`, and reports `budget_overage_halt` rather than the ordinary
  `budget_blocked`, so "we reached the ceiling" cannot be confused with "the
  estimate was wrong".
- the task keeps its own `spentCost: 3` AND its `reservedCost: 1`, so the
  estimate that was wrong is still on the record.

### A halt is sticky, and that is deliberate

A halt is a recorded fact, not a recomputed arithmetic state. If it were derived
from headroom it would clear itself the moment a cheap task settled and the run
would go green again — which is the "delete the bill and stay green" failure the
plan names. There is a test for exactly that: an overage, then a later
in-budget spend, and the halt is still there.

Only `resolveHalt` clears it, and it is a human authorization edge: `resume`
does NOT clear it (also tested). `resolveHalt` keeps `overage` and `spent`
forever — the bill is history.

### The unknown-usage path

A request whose usage never arrived keeps a conservative reservation. Two
distinct situations, and conflating them would be a bug:

- **with a task**: the amount MOVES from `reserved` to `unknownReserved`. The
  commitment total is unchanged — the credit was already committed — and the
  amount is clamped to that task's own `reservedCost`, so one task's unknown
  cannot eat a sibling's reservation.
- **without a task** (a compaction, summary or search call authorized on the
  fly): the amount was never reserved, so it is ADDED to `unknownReserved`. That
  raises the commitment total and can only tighten admission. The conservative
  direction is the whole point: an unreported auxiliary charge must not look
  like a free one.

In neither case is anything zeroed or released.

---

## R06 — all attempts accounted: CLOSED (ledger semantics), NOT_RUN (real per-attempt bills)

A `UsageLedger` accumulates `UsageAttempt` rows from multiple sources with an
explicit `unknown` state. `USAGE_SOURCES` is the plan's sentence made
mechanical: `root | child | retry | compaction | summary | search`.

The four properties the gate asks for, each with its own test:

1. **An attempt with no usage reported stays `unknown` and is not counted as
   zero.** There is no `?? 0` anywhere on that path. The test asserts the token
   buckets are zero *and* that `unknownCount` is 1 — because "nothing was added"
   and "measured as free" produce the same buckets, and only the counts
   distinguish them.
2. **A retry is a SEPARATE attempt.** `attemptId` is the identity that matters,
   not `taskId`; a retry gets its own id, its own row, and its own cost. Folding
   it into the first attempt is how a system reports one request's cost for two
   requests' work.
3. **The total reports a separate `unknownCount`** (plus `unknownUsageCount` and
   `unknownCostCount`), so a reader can see the gap. It is attributable per
   source as well as globally.
4. **The ledger never double-counts.** A repeated `attemptId` is refused; a
   repeated `requestId` is refused even under a new `attemptId`, because a retry
   that reuses a request id is the same billable request. Both refusals are
   COUNTED and visible — "we ignored a report" is itself a fact a reader needs.

The one case where a duplicate changes the totals: the first report for a
request carried no usage and a later one does. The row is REPLACED, never added
— the request still counts once and the gap closes.

### Token buckets keep DSH's disjointness

The bucket field names and the disjointness rule are copied from
`@deepseek-ai/dsh-llm`'s `TokenUsage` (`packages/llm/llm/src/types.ts:162`):

> "Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
> reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
> sum of the three)."

They are NOT collapsed into one `totalTokens`: that would erase the cache split,
which is most of what explains a cost above its reservation. `reasoningTokens`
is carried but never added into `outputTokens`, because DSH already includes
reasoning there (per the token-meter projection's own note) and adding it again
would double-count.

---

## A real bug this work found and fixed

**The drain path reported the wrong refusal reason.** `explainDeficit` computed
the reason from the run's TARGET occupancy alone, so it could not see the cost
of the request in hand. Measured: a request of 91 against a child ceiling of 90
was correctly refused by `mayAdmit`, but the reported reason was
`slots_held_by_unconfirmed` — with no task held at all. The gate refused for a
budget reason while stating a slot reason.

Fixed by adding `admissionReason(record, counts, outstandingCost)`, which makes
the same comparison `mayAdmit` makes and is now used by both the drain path and
`admissionCheck`, so the stated reason and the gate that produced it are one
decision. This is a reporting fix, not a gate change: nothing that was refused
is now admitted.

It was found by sabotage testing, not by reading — the first sabotage run
detected only 1 of the tests that should have caught a bypassed reserve, which
is what pointed at the reason string being pinned too loosely.

**One consequence to flag:** a test in another agent's `isolation.test.ts`
(C15) currently ASSERTS the old, incorrect reason and documents it as an "honest
limit". That assertion now fails. It is the behavior being asserted that is
wrong, not the fix; the failure is reported rather than worked around, and that
file is not mine to edit.

---

## TWO FINDINGS THAT NEED THE COORDINATOR'S ATTENTION

### 1. The run `epoch` is inert

`runRecordSchema` declares a monotonic `epoch` and its comment says "A callback
carrying a stale epoch must be rejected rather than allowed to write
authoritative state." **No code path reads it.** `initialRunRecord` sets it to 1
and nothing ever increments or compares it. Every mutation (`admit`,
`transition`, `recordSpend`, `spendRoot`, `retainUnknown`) is keyed on `runId`
alone and takes no epoch parameter, so there is no way for a caller to present a
stale epoch and no way for the service to reject one.

INV-L3 as written is therefore **not enforced by the epoch**; it is enforced by
the tool-protocol guard's live-Agent identity check, which is a different
mechanism (and see finding 2). The field is not harmful, but it is currently
documentation for a mechanism that does not exist. Either it should be removed,
or the rejection it describes should be implemented — it should not stay as a
comment that reads like a guarantee.

### 2. The tool-protocol guard is NOT mounted by the shipped profile

`packages/dsh-daily-work/cordis.patch.yml` DOES declare
`daily-work-tool-protocol-guards`, and `package.json` declares it via
`dsh.bundle.patch`. But that patch is reached only if the profile lists this
package as a bundle, and **`profiles/daily-candidate/package.json` lists only
`@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`** — not
`dsh-daily-work`. The profile's own `cordis.patch.yml` mounts only
`dsh-daily-work/host`.

Measured, not inferred: `qualification/results/M9.21-guard-mounted/guard.json`
reports

```
"guardMounted": null,
"forgedOwnerDenied": false
```

from a real boot. So the guard exists, is correct, and is not installed. B04's
production closure is incomplete: the forged-owner denial that the guard
implements does not happen in the shipped configuration.

`profiles/daily-candidate/package.json` and `cordis.patch.yml` are owned by the
coordinating agent and were deliberately NOT changed by this case.

---

## Falsification: the tests can fail

`tsc` passing and `vitest` passing prove the tests RUN, not that they TEST
anything. Four mutations were applied to the real source, each was run, and the
source was restored (md5 verified identical afterwards):

| mutation | tests that failed |
| --- | --- |
| `childCeiling` stops subtracting the root reserve | 10 of 43 |
| overage absorbed (`spent` clamped to the reservation) and unknown zeroed | 9 of 43 |
| the admission gate ignores a recorded halt | 5 of 43 |
| unreported attempt counted as zero usage, and a reused request id summed twice | 5 of 43 |
| **control — restored source** | **43 of 43 pass** |

Raw output in `sabotage.txt`.

---

## Files

**Created by this case (nothing else was touched):**

- `packages/dsh-daily-work/src/cost.test.ts` — 43 tests
- `qualification/results/M9.6-cost/{FINDINGS.md,tests.txt,tsc.txt,source-digests.txt,sabotage.txt}`

**Modified, the minimum the three gates need:**

- `src/record.ts` — `rootReserve`/`rootSpent`/`overage`/`halt` on `budgetSchema`
  (all optional, so a record written before this change still validates and
  `WORK_SCHEMA_VERSION` does not move); `childCeiling`, `childCommitted`,
  `childHeadroom`, `rootAvailable`, `isHalted`, `applySpend`, `retainAsUnknown`,
  `holdUnknown`, `budgetReport`; `UsageLedger`, `UsageAttempt`, `UsageBuckets`,
  `bucketsFromTokenUsage`.
- `src/host.ts` — `createRun` carves the reserve; `admit` enforces the child
  ceiling and the halt; `transition` routes spends through `applySpend`;
  `recordSpend`, `spendRoot`, `retainUnknown`, `resolveHalt`, `budget`,
  `admissionCheck`.
- `src/counting.ts` — `mayAdmit` measures against the child ceiling and refuses
  while halted; `admissionReason` added; `budget_overage_halt` added to
  `DeficitReason`.

The schema fields are optional rather than required on purpose: the storage
domain validates on READ, so a required field would make every record written
before this change fail to open, which is the silent-migration failure the
schema-version comment forbids. An absent reserve means ZERO reserve, which is
the conservative reading.
