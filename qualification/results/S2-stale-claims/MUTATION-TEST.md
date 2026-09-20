# S2 — the corrected test, and the two mutations that prove it is load-bearing

**File:** `packages/dsh-daily-work/src/upg-gates.test.ts`
**Test added:** `UPG-08 > SEC-06 says DELETED, not "exists but unreachable", and the tree agrees with the row`

## Why this test exists

The `GATES` table in that file is a hand-written list of 24 rows, and row
`SEC-06` read:

> The run-record epoch guard **exists** and is tested but has NO production
> importer: the field is inert (G-SEAM-21).

R9 then **deleted** the guard, its `WorkerSettlement` type, its `RefusalLedger`,
the `dsh_daily_work_refusals` domain and the run record's `epoch` field
(`6bfc810` + `00421ec`). The row kept asserting the existence of a mechanism that
no longer exists.

**It passed anyway, because a summary string is not a measurement.** Nothing in
the suite compared that sentence against the tree. This is the project's
most-recorded defect class — an oracle weaker than its scenario — appearing one
level above the code it usually appears in: the gate table certified a claim about
the product without ever looking at the product.

## What the replacement asserts (a real assertion, not a deletion)

1. `SEC-06.status === 'FAIL'`.
2. the summary contains `DELETED` and does **not** contain `guard exists`;
3. **no production module reads or writes a RUN epoch** — comments stripped first,
   and `kernel-lifecycle.ts` excluded **by name** as the KERNEL epoch, a different
   field sharing the word (G-SEAM-43). This is the enumeration R9 derived for the
   same purpose, not a fresh hand-picked list, because a hand-picked list is how
   R9's first instrument hid the input that mattered;
4. **no production module contains `applyWorkerSettlement` / `RefusalLedger` /
   `WorkerSettlement` in code.** Comments may name them: that is where the
   deletion is documented, and forbidding the names would delete the documentation;
5. `record.ts`'s schema does not declare `epoch`, **and** the documented removal
   (`THERE IS NO \`epoch\` FIELD HERE`) is present — so the check cannot be
   satisfied by simply erasing the evidence;
6. **a positive control**: `kernel-lifecycle.ts` must still match `epoch`.

Assertion 6 is what keeps the two empty results from being an empty negative of a
broken scan. Without it, a typo in the comment-stripping regex would make every
check vacuously pass — the failure mode round 1 hit when a `String.includes` scan
reported a LIVE function as deleted.

## Mutation proof — both injections MUST fail, and both did

Measured with `node node_modules/vitest/vitest.mjs run src/upg-gates.test.ts -t 'SEC-06 says DELETED'`.

### Mutation 1 — the stale text returns

Revert the summary to `'The run-record epoch guard exists and is tested but has NO
production importer: the field is inert: ...'`.

```
FAIL  src/upg-gates.test.ts > UPG-08: the daily verdict, COMPUTED from the per-gate results
      > SEC-06 says DELETED, not "exists but unreachable", and the tree agrees with the row
AssertionError: SEC-06 must say DELETED: expected 'The run-record epoch guard exists and…' to contain 'DELETED'

 Test Files  1 failed (1)
      Tests  1 failed | 50 skipped (51)
```

**Required: FAIL. Observed: FAIL.**

### Mutation 2 — the mechanism returns (a real code change, not a string)

Add `epoch: z.number().int().positive(),` to `runRecordSchema` in
`packages/dsh-daily-work/src/record.ts`.

```
FAIL  src/upg-gates.test.ts > UPG-08: ... > SEC-06 says DELETED, ...
AssertionError: no production module may read or write a RUN epoch
      at src/upg-gates.test.ts:1819

 Test Files  1 failed (1)
      Tests  1 failed | 50 skipped (51)
```

**Required: FAIL. Observed: FAIL.**

### Restored

Both mutations reverted; `record.ts` re-checked (its only `epoch` mentions are
comment lines at 410 and 413), and the file then passes **51/51**:

```
node node_modules/vitest/vitest.mjs run src/upg-gates.test.ts
 Test Files  1 passed (1)
      Tests  51 passed (51)
```

## What this does NOT prove

- It does **not** prove no other gate row's note is stale. It closes the epoch
  mechanism specifically, because that is the one this slice measured. See
  `FINDINGS.md` §5.3 and the slice report's `UNRESOLVED`.
- It does **not** make the product fence a stale generation. The test asserts the
  absence of a claim, not the presence of a control.
