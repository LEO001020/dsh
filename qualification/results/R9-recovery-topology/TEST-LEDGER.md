# R9 — per-test change ledger (what each changed assertion claimed before and now)

Root asked for this explicitly: *"A test that passed because a guard existed, and
now passes because the guard is gone, must not silently become a test of nothing."*

For each touched test file: what it asserted **before**, what it asserts **now**,
and why the change is a removal of an assertion about a deleted mechanism rather
than a weakening of an unrelated one.

Measured at `a4b0838` + this change, worktree `D:\DSH\work\wt-r9`, branch `wt/r9`.
Run commands and outcomes are in `TEST-RESULTS.txt`.

---

## 0. POST-FALSIFICATION REVISION (read first)

Root falsified a sentence this ledger's first version relied on. Two test regexes —
in `durability-advanced.test.ts` and `durability-records.test.ts` — checked
"no production call site targets a terminal state" using a **hand-picked state list
that omitted `unknown`**:

```
/to:\s*'(?:settling|confirmed|cancelled|executing|cancel_requested)'/u
```

That omission is why the claim survived review: the instrument was built to confirm
the sentence it was supposed to test. `host.ts:1342` and `host.ts:1364` do write
`unknown` on the drain path. **This is `G-FIX-04`'s defect class — an oracle weaker
than its scenario — produced by me, in the test I wrote to prevent exactly this.**

**What changed:**

| Item | Before | After |
|---|---|---|
| The terminal set | hand-picked literal list | **derived from `TERMINAL_STATES`** (`states.ts:67-70`), so a state cannot be silently omitted again |
| The `unknown` write | invisible (excluded by the regex) | **asserted explicitly**: the `unknown`-writing file set must equal `['host.ts','recovery.ts']`, with both `host.ts` sites matched including their `releaseReservation: false` |
| The deciding fact | "no production call site targets a terminal state" | **plus** the stronger behavioural fact: nothing can move a task *out of* `unknown` |

**New test added:** "and nothing can move a task OUT of `unknown`, which is the
state the product leaves it in" — drives the real drain with a failing port,
confirms the task lands in `unknown` with its reservation held, then measures that
**both** available exits fail: a re-drain (refused by `admit`, `host.ts:823-825`) and
`relaunchPrepared` (refuses anything not `prepared`). This test would have caught the
original overclaim, because it asserts what the product *does* do rather than what it
does not.

**Unchanged by the correction:** the DELETE decision, every other assertion, and
every row below. No test was weakened; the two regexes were made stricter.

---

## 1. `durability-advanced.test.ts` — the T9-A section (rewritten)

**Before:** seven tests in `describe('T9-A: the epoch guard (G-SEAM-21) —
unreachable, and what that costs')`:

| # | Old assertion | Fate |
|---|---|---|
| 1 | `recovery.ts` has no production importer; no production writer of `epoch` | **KEPT, strengthened** — still asserts no production importer, and now also that no production file mentions a run epoch at all. |
| 2 | `recovery.ts` is in no package entry point's transitive closure, with `host.ts` as positive control | **KEPT unchanged** — the closure walk survives, with its `host.ts` control, and still measures `recovery.ts` and `reconcile.ts` as unreachable. Its subject is the reachability of the recovery modules as a class, which is what the topology measurement rests on. |
| 3 | Only tests reach `reconcile.ts`/`recovery.ts`, so the product never reconciles | **KEPT unchanged** — this test was not about the epoch and is untouched in substance. It still measures that `reconcileTask` / `relaunchPrepared` have no production caller, that `reconcile.ts`'s only production importer is the hand-run CLI, and that the CLI is itself unreachable. Only its docstring changed (it named the deleted guard as a third example). **This is the independent corroboration of the topology measurement**, since it re-derives the importer sets rather than citing them. |
| 4 | `transition` takes no epoch, so the check cannot be expressed; a stale-epoch settlement IS applied and releases the reservation | **REPLACED** by "no production call site can write a terminal task state". The old test measured *the write path ignores an epoch*; the new one measures the stronger, deciding fact: **no production call site targets a terminal state at all.** The old test's scenario (a settlement offered to `transition`) is no longer constructible, because the only non-test caller that named terminal states was the code now deleted. |
| 5 | A real SIGKILL + real re-adoption do NOT bump the epoch (still 1) | **REMOVED as no longer meaningful** — the field does not exist, so "it is not bumped" is vacuous. The underlying phenomenon it protected (a re-adopted generation reads exactly what the previous one committed) is **re-asserted in `durability-records.test.ts` D10**, which now measures the durable cross-generation read. Nothing about restart behaviour was lost; the assertion moved to the property that is still true. |
| 6 | WITHOUT the guard, a stale settlement is applied and releases the reservation | **REMOVED** — it was a demonstration of damage from a path that cannot be reached. It required calling `transition` with terminal targets, which no production code does. |
| 7 | WITH the guard, the same settlement is refused and retained | **REMOVED** — it tested the deleted mechanism directly. |

**Added (new, not replacements):**

- "the deleted settlement machinery has no surviving reference anywhere in the
  source" — over production files, code-only (comments may name the deleted
  symbols, since that is the documentation); over test files, it checks that no
  test **imports** a deleted symbol. This is strictly stronger than the old
  import scan.
- "the run record no longer carries an epoch, and nothing writes or reads one" —
  asserts the field is gone from schema and initialiser, and that no production
  module (excluding `kernel-lifecycle.ts`'s different KERNEL epoch) mentions it.
- "`host.ts` no longer claims a per-await epoch re-check it does not perform" —
  the two false comments are corrected and the correction is asserted, so the
  claim cannot return. This test is **new coverage**, not a removal: before this
  slice, no test asserted that `host.ts`'s prose matched its code (the old
  `sec-gates` test asserted the *contradiction*).
- "the v1 FAIL is preserved: REC-09 and REC-10 still read FAIL in the frozen
  spec" — new, and it is the guard against this slice being read as a fix.

**Net:** the section goes from "the guard is correct but unreachable" to "the guard
is deleted, here is the topology fact that decided it, and here is the proof the
removal is total". No assertion that was about something else was weakened.

---

## 2. `durability-records.test.ts` — the D10 section (rewritten)

**Before:** three tests in `describe('D10: an old worker submits a settlement after
a restart')`:

| # | Old assertion | Fate |
|---|---|---|
| 1 | A stale epoch is refused, the refusal is durably retained in `dsh_daily_work_refusals`, the authoritative state is untouched, and a second generation sees the refusal | **REPLACED** by "a second generation over the same store reads exactly what the first committed". The durable cross-generation read is the real property that survives; the refusal half tested the deleted mechanism. |
| 2 | A mismatched `childId` is refused and retained; the current settlement IS applied | **REMOVED** — it drove `applyWorkerSettlement` directly. Its *identity* concern is not lost: `reconcileTask`'s refusal to release a slot on a mismatched identity is kept as test 3 below, and it is a reachable-module decision. |
| 3 | Reconciliation keys on the task, so the record childId is the identity that matters | **KEPT, unchanged** — still asserts `decision.releaseSlot === false` for a mismatched identity. This is the half of "stale" that was always a real property of a reachable module. |

**Added:** "no settlement entry point exists, so there is no stale-write path to
guard" — re-derives from the tree that no production file mentions the deleted
symbols in code, that the only non-test module naming a terminal target is the
unreachable `durability-runner.ts`, and that the CLI itself has no importer.

**Also changed in this file (not D10):** the D09 malformed-record test used to
corrupt the stored record's `epoch` to trigger `invalid-record`. Since the field no
longer exists, it now corrupts `requestedTarget` (a non-negative integer) with a
string. **Same claim, same mechanism, different field** — the test still proves the
domain rejects a schema-violating record at open. This is the one change in this
file that is a substitution rather than a removal, and it is called out here
because a reader could otherwise mistake it for a weakening.

---

## 3. `sec-gates.test.ts` — the SEC-06 section (rewritten)

**Before:** four tests.

| # | Old assertion | Fate |
|---|---|---|
| 1 | The guard exists in `recovery.ts` (regex on the epoch comparison) and `docs/GAPS.md` records it as unreachable | **REPLACED** by "the epoch guard is DELETED, and this gate is a recorded NON-CLAIM": asserts the epoch comparison is gone from `recovery.ts` **in code**, that `relaunchPrepared` is deliberately kept, that the record schema declares no epoch, and that G-SEAM-21 is still recorded. |
| 2 | An import-graph scan: no production module imports `recovery.ts`; no production module reads `.epoch` | **KEPT and strengthened** — same scan, plus the epoch-reader half is now a total-absence assertion. |
| 3 | The field's own comment says it is NOT enforced | **REPLACED** — the field is gone; the equivalent claim is now the presence of the documented removal in `record.ts`. |
| 4 | `host.ts` claims a per-await epoch re-check its code does not perform (asserting the **contradiction**) | **INVERTED** into "the host service no longer claims a per-await epoch re-check it does not perform" (asserting the **correction**). Same two real checks (`this.disposed`, `signal.aborted`) are still asserted, so the test still pins what the await-boundary guard actually is. |

**Note:** test 4's inversion is the one place where a test that used to assert a
defect now asserts its absence. That is intentional and is the point of the slice —
but it means SEC-06's record-epoch half no longer has a failing assertion. The
**FAIL is preserved in v1**, and the non-claim is asserted in
`durability-advanced.test.ts` test 5.

---

## 4. `tool-protocol.test.ts` — one test

**Before:** "the run epoch is inert, so identity is the only enforceable check" —
asserted `getRun('run-1')?.epoch === 1` before and after a stale-owner `finish`.

**Now:** "the run record carries no epoch, so identity is the only enforceable
check" — asserts the record has no `epoch` key, and adds the assertion the old test
lacked: after the stale object's `finish`, **the run is still `phase: 'open'`**,
i.e. the object-identity guard actually refused it. The old test asserted only that
a field was stable, which proved nothing about the guard. The new assertion is
strictly stronger and is about the reachable mechanism.

---

## 5. `isolation.test.ts` — one assertion

**Before:** `expect(second.epoch).toBe(1)` — "new work needs a new run, with its own
authorization ref and epoch 1".

**Now:** `expect(Object.hasOwn(second, 'epoch')).toBe(false)` — same location, same
test, same intent (a second run is a distinct record with its own authorization),
with the deleted field's assertion inverted. The rest of the test (the two records
coexist, neither overwrote the other) is untouched and is what the test is really
about.

---

## 6. `upg-gates.test.ts` — one assertion

**Before:** `expect(record?.epoch).toBe(1)` — "the restored record is at its
ORIGINAL epoch, not a bumped one: a restore is not a new generation".

**Now:** `expect(Object.hasOwn(record!, 'epoch')).toBe(false)`. The surrounding
test still measures what it was written for — a backup/restore round trip produces
a byte-identical store that opens in a fresh host with all fields intact — and the
field list it checks is otherwise unchanged.

---

## 7. `reconcile.test.ts` — comment only

One docstring sentence listed "the `recovery.ts` epoch guard" among examples of the
unreachable-mechanism class. Updated to record that it was **deleted rather than
wired**. No assertion changed. The section's substantive claims (a launched child
reaches `accepted` and never leaves it; the only states the product can produce are
`launching`, `accepted`, `unknown`) are untouched — and they independently
corroborate this slice's topology measurement.

---

## Summary

| File | Old assertions removed or replaced | Assertions added | Assertions inverted | Weakened |
|---|---|---|---|---|
| `durability-advanced.test.ts` | 4 (rows 4-7: the epoch-is-inexpressible measurement, the epoch-bump measurement, the without-guard damage demonstration, the with-guard refusal) | 5 | 0 | 0 |
| `durability-records.test.ts` | 2 (stale refusal + retention, mismatched-child refusal via guard) | 1 | 0 | 0 (1 field substitution in D09, called out) |
| `sec-gates.test.ts` | 2 (guard exists, comment says not-enforced) | 1 | 1 (contradiction → correction) | 0 |
| `tool-protocol.test.ts` | 0 | 1 | 1 (field stability → guard refusal) | 0 |
| `isolation.test.ts` | 0 | 0 | 1 | 0 |
| `upg-gates.test.ts` | 0 | 0 | 1 | 0 |
| `reconcile.test.ts` | 0 (comment only) | 0 | 0 | 0 |

Of `durability-advanced.test.ts`'s four removed rows, three are outright removals
(rows 5-7) and one is a replacement (row 4), whose subject — what the write path
can express — is re-measured in stronger form by the new "DECIDING topology fact"
test.

No assertion about a mechanism that still exists was weakened or removed. Every
removal is an assertion about the epoch guard, the settlement API, the refusal
ledger, or the `epoch` field — all four of which no longer exist.
