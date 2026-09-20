# S2 — every surviving claim of the deleted recovery guarantee, and its correction

**Slice:** the documentation still claimed a recovery guarantee the product does
not provide. **Writer:** S2. **Worktree:** `D:\DSH\work\wt-s2`, branch `wt/s2`.

**What this directory is for.** R9 (V3 F8) established that the run-epoch /
worker-settlement machinery was DELETED rather than wired, and supplied a list of
NINE doc sites that still asserted the deleted guarantee. This directory records,
for each site: what it claimed, what is true, and what it says now. It also
records the sites R9 did not list, including one that is a **gate verdict** and
one that is a **test assertion**.

**Nothing here changes product behaviour.** Correcting a document does not add,
restore or remove a mechanism. The only non-document change in this slice is one
test assertion that had been checking a mechanism's existence after the mechanism
was deleted.

---

## 0. THE FACTS, MEASURED ON THIS TREE

Re-derive them with `python qualification/results/S2-stale-claims/probe.py`
(read-only, exit 0 = facts hold, exit 1 = the tree has moved and this directory is
stale). Output archived at `probe-output.txt`. The probe carries **positive
controls**, because every fact below is an absence and an empty negative of a
broken scan looks identical to a real one:

| Control | What it proves |
|---|---|
| `host.ts` yields the call sites `['accepted', 'launching', 'unknown']` | the call-site scan is not silently matching nothing |
| `kernel-lifecycle.ts` still matches `epoch` | the run-epoch scan is not empty because the pattern broke |
| the pattern requires the terminator `[,}]` | a type annotation is not counted as a write (R9's second instrument defect) |

| # | Fact | Where |
|---|---|---|
| 1 | **No production call site targets a terminal task state** (`settling`, `confirmed`, `cancelled`, `cancel_requested`). `WorkService.transition` is the only method that can write a task's state, its reservation release and its tombstone. | `host.ts:1601-1658` (definition); the only production call sites are `host.ts:2223` (`launching`), `:2232-2238` and `:2261-2267` (`unknown`), `:2279` (`accepted`), and `recovery.ts:145` / `:167` / `:184` in the unreachable `relaunchPrepared` |
| 2 | The product DOES write the **non-terminal** uncertainty state `unknown`, both sites with `releaseReservation: false`, so the slot stays held. | `host.ts:2232-2238` (no launch port), `host.ts:2261-2267` (launch failed) |
| 3 | **Nothing can move a task OUT of `unknown`.** `admit` refuses a slot-holding task; `unknown` holds a slot; `relaunchPrepared` refuses anything not `prepared`. | `host.ts:1442-1450`; `states.ts:56-64` (`unknown` in `SLOT_HOLDING_STATES`); `recovery.ts:103-113` |
| 4 | The launch port resolves at the ADMISSION edge and is never called back on completion, so there is no settlement producer. | `launch-port.ts:9-20`; `host.ts:2227-2280` |
| 5 | **The run record's `epoch` field does not exist**, and its absence is documented in the schema rather than silent. | `record.ts:406-441` |
| 6 | **No production module mentions a run epoch in code.** The only file with the word in code is `kernel-lifecycle.ts`, the KERNEL epoch — a different field (G-SEAM-43). | probe §2; `host.ts:23-25`, `record.ts:410-441` |
| 7 | **What IS enforced is object identity**, comparing the registry entry by OBJECT, which covers an in-process resume. | `tool-protocol-guards.ts:17-40` (`ctx.agents.get(id) === owner`); `host.ts:669-675` |
| 8 | A settlement is the act of LEAVING an in-flight state. Facts 1-4 mean **that write has no production call site in any generation, stale or current** — which is why the guard's input cannot be constructed, and why wiring it would have been a fabrication rather than a fix. | `recovery.ts:188-255` states the measurement |

**Terminal state set, derived from the product rather than hand-picked:**
`TERMINAL_STATES = confirmed | cancelled` (`states.ts:67-70`). The wider set in
fact 1 includes the two in-flight-but-ending states, because a settlement would
have to write those too.

---

## 1. R9'S NINE SITES — CLAIMED vs TRUE vs NOW

| # | Site | What it claimed | What is true | What it says now |
|---|---|---|---|---|
| 1 | `docs/GAPS.md:37` (G-SEAM-21) | the guard is "UNREACHABLE, so the field is inert"; status `OPEN`; *"To close it, call `applyWorkerSettlement` from whatever path receives a worker settlement"* | the guard, its type, its ledger, its domain and the field were all **deleted**; the field's absence is documented in `record.ts:410-441` | status **CLOSED BY DELETION**; the obsolete "wire it" instruction replaced with the topology fact and what IS enforced. **The deleted function is no longer named as a repair action anywhere in this file.** |
| 2 | `docs/RECOVERY.md:3-12` (caveat) | "Two of the mechanisms are additionally unreachable on their own terms: the epoch guard (step 2) and the reconciliation path" | the epoch guard is not unreachable, it is **gone**; the reconciliation path is still unreachable | caveat now separates the two: one unreachable, one deleted, with the reason a removed claim must not look like a claim never made |
| 3 | `docs/RECOVERY.md:45-56` (step 2) | "**An old epoch is never reused** — the guard that would refuse a stale-epoch settlement is real and tested and is not reachable" | no epoch exists to reuse; the guard is deleted; the *replacement* claim is object identity | step 2 rewritten: what was deleted and why wiring was forbidden, the four file:line facts that make the input unconstructible, and the non-claim (v1 REC-09/REC-10 stay FAIL) |
| 4 | `docs/DELIVERY.md:689-696` (limits §8.1 item 4) | "The run record's `epoch` field is inert in the product. The guard that would enforce it is real and tested, but `recovery.ts` is not reachable" | same as #3 | item retitled to "NO `epoch` field and no settlement guard — DELETED, not wired", with the topology reason and the NON-CLAIM statement |
| 5 | `docs/DELETE-AUDIT.md` — six sites: inventory rows `:146`, `:195`, `:224`, `:232`; §3.8 table `:648`; §3.8.1 `:679-749`; §4.1 `:454` | `recovery.ts` owns the `epoch` guard and the `dsh_daily_work_refusals` domain; the field set includes `epoch`; §3.8.1's *"Next executable repair action"* says to **wire** `applyWorkerSettlement` | the guard and the domain are deleted; the field is out of the schema; the recommended repair is superseded | all six corrected. §3.8.1's finding is **preserved as history** with a banner saying the recommended action is superseded, and its status changed `OPEN` → **CLOSED BY DELETION**. The other five rows record the deletion inline. |
| 6 | `docs/INVARIANTS.md:25` (INV-L3) | "Authority is bound to the exact live Agent object **plus run epoch**" | the enforcement is object identity alone | INV-L3 reworded to object identity, with the **scope** stated (in-process resume covered; cross-process NOT covered and NOT claimed) and a note that the wider wording named a deleted field. **This was the most important site** — the only one that stated the guarantee as an invariant. |
| 7 | `ARCHITECTURE.md:54` | "every operation resolves the exact live Agent **and run epoch**" | object identity only | "and run epoch" removed, replaced with the identity mechanism and pointers to `host.ts:23-25` / `record.ts:410-441` / R9's directory |
| 8 | `README.md:296-298` | "**The epoch guard is unreachable** (`G-SEAM-21`), so the run record's `epoch` is inert" | deleted, and v2 does not claim the guarantee | restated as a **NON-CLAIM** with the reason, and the KERNEL-epoch conflation warning (G-SEAM-43) kept |
| 9 | `docs/decisions/AUDIT-REQUEST-acceptance-results.md:162` (F8 row) and `:238` (§2.5 row 3) | F8: "`epoch` 字段…无人 bump、无人读"; §2.5: status "未修（F8）" | F8 was resolved by **deletion**, not left unfixed | the **measurements are preserved verbatim** (this file is the audit request, and a measurement is history); a disposition row was added to the F8 table and the §2.5 status updated to "已处置：删除，不接线". The open question at `:279` (Q5) also carries the answer now. |

**One line-number caution.** R9's list gave `docs/DELETE-AUDIT.md` as "(multiple)"
and `docs/RECOVERY.md:10-15, 45-56`. On this tree the RECOVERY caveat is at
`:3-19` and step 2 at `:45-66`; the DELETE-AUDIT sites are the six above. Line
numbers had moved, as R9 predicted; each site was located by grepping the CLAIM,
not the number.

---

## 2. SITES R9 DID NOT LIST

R9's nine were all prose. A whole-repo sweep for the claim vocabulary (`epoch`,
`settlement`, `settling`, `stale`, `INV-L3`, `applyWorkerSettlement`,
`RefusalLedger`, `WorkerSettlement`, `dsh_daily_work_refusals`) over every file
except `node_modules`, the pinned checkout and R9's own directory found **two more
sites inside this slice's ownership, and they are not prose**:

### 2.1 `qualification/gates.json` D10 — A GATE VERDICT, AND IT WAS PASSING ON A FALSE STATEMENT

**This is the consequential finding of the slice.** Full detail in
`GATE-DECISION.md`; the summary:

- D10's `status` was `PASS` and its `note` asserted *"A real guard now refuses a
  stale-generation settlement, with diagnostic evidence going to a SEPARATE domain
  (`dsh_daily_work_refusals`)"*.
- The guard existed when that note was written (`24515d1`, 2026-09-19) and R9
  **deleted** it (`6bfc810`, 2026-09-20). The row was never re-judged.
- Its oracle — frozen in `qualification/specs/gate-spec.json`, which may **not**
  be edited (`compatibility.lock.json` pins its digest
  `b6e68075…`, re-verified on disk) — requires the authoritative write to be
  REFUSED and the attempt RETAINED as diagnostic evidence. **Neither half is
  delivered**: there is no refusal mechanism, and no ledger to retain anything.
- **Verdict changed `PASS` → `FAIL`** in both the report and its generator, with
  the counts in `gates-summary.json` updated in step.

### 2.2 `packages/dsh-daily-work/src/upg-gates.test.ts:1709` — A TEST ASSERTING STALE TEXT

The SEC-06 row in that file's `GATES` table read *"The run-record epoch guard
**exists** and is tested but has NO production importer: the field is inert"*.
R9 deleted the guard, so the row asserted the existence of a mechanism that no
longer exists, and it passed because a **summary string is not a measurement** —
this project's recorded defect class, one level up from where it usually appears.

Corrected to a real assertion, and mutation-tested (§3 below). This is the one
change in this slice that touches a test file, and it is the exception the
assignment names ("where a test asserts stale doc text").

### 2.3 Found, outside my ownership — REPORTED, NOT TOUCHED

| Site | What is stale | Why I did not edit it |
|---|---|---|
| `docs/decisions/TRUSTED-LOCAL-SPEC.md:71,171` | "the 85 PASSes in `qualification/gates.json`" — now 84 after the D10 correction | not in my file list; a count reference, not a guarantee claim |
| `qualification/runners/file-result.py:424` | the `--vocabulary-test` topology string says "`applyWorkerSettlement` has no production caller" — true, but it is now deleted rather than caller-less | it is a **live runner** whose self-test asserts that string; changing it is a change to qualification tooling, and the string is not false (a deleted function also has no caller) |
| `qualification/results/**` (M9.6, M9.11, M9.15, M10-shrink, P3-security, R3-unwired, R10-security, T9-recovery, V6-recovery, M-DEP-SEC-UPG) | these directories describe the guard as existing | **verdict artifacts are historical evidence and must not be edited.** Each is a measurement taken at a named commit; rewriting it would destroy the audit trail this project depends on. The correction belongs in the current documents, which is where I made it. |
| `docs/GAPS.md` structural questions | the ledger has duplicate finding numbers and entries whose status vocabulary is inconsistent | **writer S14's slice**, per the root agent's ownership boundary. Described, not done. |

---

## 3. THE TEST CORRECTION, AND ITS MUTATION PROOF

`upg-gates.test.ts` — the new test
*"SEC-06 says DELETED, not 'exists but unreachable', and the tree agrees with the
row"* asserts the row against the **tree**, not against itself:

- the summary contains `DELETED` and does not contain `guard exists`;
- no production module reads or writes a RUN epoch, with `kernel-lifecycle.ts`
  excluded **by name** as the KERNEL epoch (G-SEAM-43) — the enumeration R9
  derived, not a fresh hand-picked list;
- no production module contains `applyWorkerSettlement` / `RefusalLedger` /
  `WorkerSettlement` **in code** (comments may name them: that is the
  documentation);
- `record.ts`'s schema does not declare `epoch`, and the documented removal is
  present;
- **a positive control**: `kernel-lifecycle.ts` must still match `epoch`, so the
  empty results cannot be an empty negative of a broken scan.

**Mutation proof (both required to fail, and both did):**

| # | Injection | Result |
|---|---|---|
| 1 | revert the SEC-06 summary to the stale *"the run-record epoch guard exists and is tested"* | **FAILED as required** — `AssertionError: SEC-06 must say DELETED: expected 'The run-record epoch guard exists and…' to contain 'DELETED'` |
| 2 | resurrect the field in the product: add `epoch: z.number().int().positive()` to `runRecordSchema` (`record.ts`) | **FAILED as required** — `AssertionError: no production module may read or write a RUN epoch` |

Restored after each; the file then passes 51/51.

---

## 4. TEST RESULTS

One file at a time, per the CPU rule. Every file below reads a document this
slice edited.

```
node node_modules/vitest/vitest.mjs run src/upg-gates.test.ts        -> 51 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/sec-gates.test.ts        -> 46 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/dep-gates.test.ts        -> 37 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/durability-advanced.test.ts -> 33 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/durability-records.test.ts  -> 25 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/reconcile.test.ts        -> 18 passed / 0 failed
```

Identity measured under: worktree `D:\DSH\work\wt-s2`, branch `wt/s2`, at the
commit named in the slice report. These are the tree's own test files reading the
tree's own documents — they prove the documents still satisfy every assertion that
pins them, and nothing about product behaviour.

---

## 5. WHAT THIS DIRECTORY DOES NOT ESTABLISH

1. **It does not change the product.** Not one production file changed. The
   guarantee is still not provided, and it was not provided before either.
2. **It does not make REC-09/REC-10 pass.** Both stay `FAIL` in the frozen v1
   spec. The D10 change moves a gate in the **OLD 104-case report**, which
   `compatibility.lock.json` describes as "retained as history"; it does not touch
   the 109-case trusted-local spec that the current work is judged against.
3. **It does not establish that D10's FAIL is the only verdict that was passing
   on a false statement.** I re-judged D10 because its note named a mechanism R9
   deleted. I did not audit the other 103 rows' notes against the tree, so a
   similar drift elsewhere would not have been found by this slice. See
   `UNRESOLVED` in the report.
4. **It does not prove the cross-process case is safe.** It proves the project
   does not claim it. Those are different statements, and the second is the one
   made.
5. **`gates.json` was NOT regenerated by running `build-gates.py`.** Measured: a
   run today stamps the lock's CURRENT identity (`0a0996f3…`) onto every PASS
   row, while the checked-in report is bound to `ece4037a…`. Regenerating would
   re-label 84 historical measurements with an identity they were not taken
   under — the defect class the lock's own `decision_reason` records. The
   generator and the report were therefore edited in step by hand, and the
   identity stamps were left alone. Re-derive with `restamp-probe.py`; its output
   is archived at `restamp-probe-output.txt`.
6. **It does not re-verify any evidence file's content.** It re-hashed all 125
   references in the edited report against disk (125 match, 0 missing, 0 stale),
   which proves the files are the ones the report names — not that the
   measurements inside them are correct.
