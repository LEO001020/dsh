# S2 — the D10 gate verdict: `PASS` → `FAIL`

**THIS IS A VERDICT CHANGE. It moves one gate in the OLD 104-case report from
`PASS` to `FAIL` and the report's totals from 85/2 to 84/3.**

Files changed: `qualification/gates.json` (the report),
`qualification/runners/build-gates.py` (its generator),
`qualification/gates-summary.json` (the companion counts).

---

## 1. WHAT WAS WRONG

`qualification/gates.json` D10 read `status: "PASS"`, with this note:

> CORRECTED EVIDENCE. … A real guard now refuses a stale-generation settlement,
> with diagnostic evidence going to a SEPARATE domain (`dsh_daily_work_refusals`)
> so a refusal can never be mistaken for authority or take the run record write
> chain. LIMIT: object identity and this guard cover the in-process case; a
> cross-process re-adoption still has no epoch enforcement.

That note was **true when written** and the row was **never re-judged after the
mechanism it describes was deleted**:

| Event | Commit | Date | Effect on D10's note |
|---|---|---|---|
| the guard, the `RefusalLedger`, the `dsh_daily_work_refusals` domain and the epoch comparison were ADDED | `24515d1` | 2026-09-19 19:55 | the note was written here and was accurate |
| the same machinery was **DELETED** | `6bfc810` | 2026-09-20 09:53 | the note became false |
| the deletion's basis was strengthened (falsified sentence corrected, instrument hardened) | `00421ec` | 2026-09-20 10:08 | still false; no row re-judgement |

Both commits are ancestors of this branch's HEAD. So the report had been carrying
a `PASS` justified by a mechanism that no longer exists — for one day, in the
report that decides promotion.

**This is the same defect class the project has recorded more than twelve times,
one level up.** The usual form is "the mechanism is implemented and nothing in the
product calls it". This form is "the mechanism is *deleted* and the report still
credits it". The test that would have caught it did not exist; §4 adds one.

---

## 2. WHY `FAIL` AND NOT A CORRECTED `PASS`

D10's oracle is frozen in `qualification/specs/gate-spec.json` and **may not be
edited** — `compatibility.lock.json` pins `gate_spec_sha256 =
b6e68075e097b5d790a406cb92820465381b6a716a84b53b0a8b8d99d584ad47`, and that digest
was re-verified against the file on disk. The oracle reads:

> 拒绝权威写入，保留diagnostic evidence。
> ("The authoritative write is refused, and diagnostic evidence is retained.")

Both halves fail today, and each fails independently:

| Oracle half | State on this tree | Evidence |
|---|---|---|
| the authoritative write is REFUSED | there is no refusal mechanism. The guard that performed it was deleted, and the run record has no `epoch` for it to compare. | probe.py §2/§2b; `record.ts:406-441`; `recovery.ts:188-255` |
| diagnostic evidence is RETAINED | there is no ledger and no domain to retain it in; both were deleted with the guard | probe.py §2b; `dsh_daily_work_refusals` appears in no production code |

The PASS therefore rested on a false statement, and the oracle is unmet.

### Why not `NOT_RUN`, and why not removal

- **Not `NOT_RUN`.** The project's own rule for this distinction is explicit and
  was applied to E01/E06: *"Recording this as NOT_RUN would understate what is now
  known: the absence of egress control is demonstrated, not assumed"*
  (`sec-gates.test.ts:801-805`, pinning the M9.3 findings). Here the absence is
  likewise **demonstrated** — by the topology measurement and by a probe with
  positive controls — not merely unmeasured. `NOT_RUN` is for "not attempted".
- **Not removal.** The delivery package's checker requires `gates.json` to be a
  bare array and the report's 104-case count is cited by the frozen v1 spec's own
  `ID-03` stimulus (*"Load `qualification/gates.json` (104 old cases, 85 PASS)"*).
  Deleting a row would silently erase the requirement from the audit record, which
  is the failure mode this whole slice exists to prevent.
- **Consistent with the newest judgment available.** The v2 definition for this
  exact mechanism (`acceptance-spec.trusted-local-v2.definition.json`, REC-10)
  says an unreachable guard is *"NOT PASS in either arm"*, and REC-09's ARM B
  requires the case be filed `NOT_CLAIMED` — *"never PASS"*. v1's vocabulary has
  no `NOT_CLAIMED`, and REC-09/REC-10 already read `FAIL`. So `FAIL` is the value
  that makes the two reports agree instead of contradicting each other.

### Why the report was edited rather than regenerated

**Measured, not assumed.** Running `build-gates.py` today stamps the lock's
current identity onto every PASS row:

```
lock identity now        : 0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461
identities in GENERATED  : {0a0996f3944b5528...}
identities in ON DISK    : {ece4037a9d5bbb01...}
PASS rows that would be re-stamped with the current lock identity: 84
```

(Re-derived after the D10 edit; before it the last line read 85. The probe is
`restamp-probe.py` in this directory, output at `restamp-probe-output.txt`.)

The checked-in report is bound to `ece4037a…`; regenerating would re-label 85
historical measurements with an identity they were never taken under. That is
precisely the defect `compatibility.lock.json`'s own `decision_reason` records
(*"this record previously named the SUPERSEDED identity 549732b5…, which is the
same defect class as the stale pins it describes -- a record naming a value that
no longer exists"*). So the generator and the report were edited **in step by
hand**, and every identity stamp was left untouched. Verified: no row's
`deployment_identity` changed.

This probe ran against a temp copy; nothing in the repository was written by it.

---

## 3. WHAT CHANGED, EXACTLY

| File | Change |
|---|---|
| `qualification/gates.json` | D10: `status` `PASS` → `FAIL`; `note` replaced with the corrected one; `deployment_identity` and `evidence` keys **removed**, which is this report's own shape for a non-PASS row (verified against E01/E06). The two former evidence paths are named inside the note so the provenance is not lost. |
| `qualification/runners/build-gates.py` | D10's tuple status `PASS` → `FAIL`; the note updated to the same text. **B04's note** also corrected: it described the epoch field as merely "INERT" and now states that the field and guard were deleted. B04 stays `PASS` — its subject is object identity, which is real and mounted. |
| `qualification/gates-summary.json` | `PASS` 85 → 84, `FAIL` 2 → 3. |
| `README.md` | the count sentence, the non-PASS gate enumeration (13 → 14, `D10` added), and the "85 gates pass" / "two FAILs" lines. |
| `docs/DELIVERY.md` | the count block, the non-PASS table (a `D10` row added), the `85 gates pass` line, and the "Two mandatory gates are honest FAILs" bullet (now three, with D10 distinguished as a *withdrawn claim* rather than a platform limit). |
| `docs/DELETE-AUDIT.md` | the counts table and the non-PASS enumeration in §4.1, plus a paragraph explaining the move. |

**The promotion decision does not change: `NOT_READY` before and after.** D10 was
mandatory, so it was already inside the mandatory set that is not closed — the
verdict was `NOT_READY` for 13 other reasons and would have been `NOT_READY` with
D10 at PASS. **What changed is the report's accuracy, not the decision.**

Counts, recomputed from the report rather than typed:

```
BEFORE: total 104 = PASS 85 · NOT_RUN 10 · FAIL 2 · BLOCKED_EXTERNAL 1 · NOT_APPLICABLE 6
        of the 88 mandatory: PASS 75 · NOT_RUN 10 · FAIL 2 · BLOCKED_EXTERNAL 1
AFTER : total 104 = PASS 84 · NOT_RUN 10 · FAIL 3 · BLOCKED_EXTERNAL 1 · NOT_APPLICABLE 6
        of the 88 mandatory: PASS 74 · NOT_RUN 10 · FAIL 3 · BLOCKED_EXTERNAL 1
```

`A12`/`E02`/`R01` and `C01` remain the pre-existing four differences between the
generator's `PARTIAL` and the report's normalised `NOT_RUN`; that normalisation is
the generator's documented behaviour (`build-gates.py:257-263`) and was not
touched.

**A knock-on the counts also move: the report's evidence-reference total goes
`127` → `125`**, because D10's two evidence references are removed with its
`PASS` (a non-PASS row carries no `evidence` key in this report's shape — verified
against `E01`/`E06`). Nothing is lost: both paths are named inside D10's note. The
integrity check that prose elsewhere describes was re-run against the edited
report: **125 references, 125 match, 0 missing, 0 stale.** The two prose passages
that cited `127` (`docs/DELIVERY.md`, `docs/DELETE-AUDIT.md` §4.1) were corrected
in place, with the historical measurement preserved and the new total stated.

---

## 4. THE CONTROL — WHAT WOULD HAVE CAUGHT THIS

A row whose note names a mechanism is not checked against the tree by anything.
The new assertion in `upg-gates.test.ts` ("SEC-06 says DELETED … and the tree
agrees with the row") closes that for the epoch mechanism specifically, and was
mutation-tested in both directions:

| Injection | Required result | Observed |
|---|---|---|
| revert the SEC-06 summary to "the guard exists and is tested" | FAIL | **FAILED as required** |
| resurrect `epoch` in `runRecordSchema` | FAIL | **FAILED as required** |

**A general version of this check does not exist and is not proposed here.** A
gate note is free prose; deciding mechanically whether a sentence about the tree is
true is not a solved problem, and a `String.includes` scan of the kind round 1
found reporting a LIVE function as deleted is the wrong instrument. The honest
statement is that D10 was found by re-reading the row against R9's deletion, and
that **the other 103 rows' notes have not been audited this way** — see the
`UNRESOLVED` field of the slice report.
