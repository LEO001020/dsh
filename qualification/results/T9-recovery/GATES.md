# T9 — the epoch guard, and whether unknown effects are ever auto-replayed

**Date:** 2026-09-20
**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`, HEAD `d86e180`
**Package under test:** `packages/dsh-daily-work`
**Test file:** `packages/dsh-daily-work/src/durability-advanced.test.ts`
(owning blocks: `T9-A: the epoch guard (G-SEAM-21)` and `T9-B: the effect ledger
across a real state rewind`)

**Commands**

```sh
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work

# the T9 gates only
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/durability-advanced.test.ts \
  -t "T9-A" --maxWorkers=2 --no-file-parallelism
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/durability-advanced.test.ts \
  -t "T9-B" --maxWorkers=2 --no-file-parallelism

# the whole file (T9-A + T9-B + T9-C, the last owned by T2)
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/durability-advanced.test.ts \
  --maxWorkers=2 --no-file-parallelism

# the typecheck baseline (must stay exit 0)
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json --noEmit
```

**Measured result**

| Block | Tests | Result |
|---|---|---|
| T9-A | 7 | **7 pass** |
| T9-B | 9 | **9 pass** |
| whole file | 32 | 30 pass / 2 fail — both failures in **T9-C**, which is byte-identical to HEAD (see §4) |

`tsc -p tsconfig.check.json --noEmit` → **exit 0**.

---

## 1. Gate table

| Gate | Assertion | Measurement command | Verdict |
|---|---|---|---|
| **G-SEAM-21a** | `recovery.ts` has no production importer | `vitest -t "no production importer"` | **PASS (finding confirmed)** |
| **G-SEAM-21b** | `recovery.ts` is in no package-entry-point transitive closure, and the walk is falsifiable | `vitest -t "unreachable from every PACKAGE ENTRY POINT"` | **PASS (finding confirmed)** |
| **G-SEAM-21c** | The only importers of `recovery.ts`/`effect.ts` are test files, so the product never reconciles | `vitest -t "only TESTS reach these modules"` | **PASS (finding confirmed)** |
| **G-SEAM-21d** | The reachable write path (`WorkService.transition`) cannot even EXPRESS the epoch check | `vitest -t "cannot even EXPRESS"` | **PASS (finding confirmed)** |
| **G-SEAM-21e** | A real SIGKILL + real re-adoption does not bump the epoch | `vitest -t "do NOT bump the epoch"` | **PASS** |
| **G-SEAM-21f** | WITHOUT the guard, a previous generation's settlement IS applied and releases the reservation | `vitest -t "WITHOUT the guard"` | **PASS (damage demonstrated)** |
| **G-SEAM-21g** | WITH the guard, the same settlement is refused and the evidence retained | `vitest -t "WITH the guard"` | **PASS (logic is correct)** |
| **D10-replay-1** | A lost reply that MAY have committed is reconciled by query; transport invoked exactly once across repeated `perform` | `vitest -t "reconciled by QUERY"` | **PASS** |
| **D10-replay-2** | The send-decision table licenses a send from exactly 2 states, both proofs about our own write order | `vitest -t "send decision table"` | **PASS** |
| **D10-replay-3** | An adapter with neither an idempotency key nor a queryable result is NOT RUN AT ALL | `vitest -t "NOT RUN AT ALL"` | **PASS** |
| **D10-replay-4** | The reachable PRODUCT path does not replay: a possibly-successful launch is quarantined and a second drain refuses | `vitest -t "PRODUCT path does not replay"` | **PASS** |
| **D10-sep-1** | A failed ATTEMPT does not imply the effect did not happen; the two are separate fields | `vitest -t "FAILED ATTEMPT does not imply"` | **PASS** |
| **D10-sep-2** | No `safe_to_retry` predicate exists anywhere; the nearest predicate refuses rather than permits | `vitest -t "safe_to_retry"` | **PASS (absence measured)** |
| **T9-B-defect** | The rehearsal's `kind`-for-`status` fixture defect is real and produces a record the schema rejects | `vitest -t "fixture defect is real"` | **PASS** |

---

## 2. Deliverable 1 — the epoch guard: UNREACHABLE, and not wireable as-is

**Verdict: the guard has zero production callers. This is instance 3 of the defect
class, confirmed by measurement, and it is NOT fixed by this run.**

The consequence is stated precisely rather than softened. `recovery.ts` implements
`applyWorkerSettlement`, which refuses a settlement whose epoch is not the record's
current epoch. That logic is **correct** — G-SEAM-21g measures it refusing and
retaining the evidence. But no production path calls it, and the damage G-SEAM-21f
demonstrates is real: a settlement from a previous generation is applied through
`WorkService.transition`, the task becomes terminal, the reservation is released,
and a tombstone is written so the task can never be re-admitted. Nothing records
that the claim was stale.

Two independent measurements agree:

| Instrument | Method | `recovery.ts` non-test importers |
|---|---|---|
| This gate (`T9-A`) | regex specifier walk from `package.json` `exports` roots, transitive closure, `host.ts` as positive control | **(none)** |
| `qualification/results/R3-unwired/import-graph.mjs` | TypeScript `ts.preProcessFile` — a real parser, not a regex | **(none)** |

R3's compiler-based scan also agrees on the test-side importers: exactly
`durability-advanced.test.ts` and `durability-records.test.ts`, which is what
`G-SEAM-21c` asserts.

**Why it is not wired by this run.** Wiring it is not a one-line change, and
`G-SEAM-21d` measures why: `WorkService.transition` — the only reachable method
that can move a task to an authoritative terminal state — **takes no epoch
parameter**. The reachable write path has nowhere to put the comparison. The test
offers `{ epoch: 0 }` to `transition` and the field is simply ignored: the
transition applies, the reservation releases, the tombstone is written, and the
record's epoch is never consulted. Closing this needs a signature change on the
product's own admission API plus a caller that receives worker settlements.

**And no such caller exists to connect.** Measured: there is no production
ingress for a worker settlement at all. The only `ctx.on` subscriptions in
production are `capacity.ts`'s `agent/created` and `agent/disposed`; there is no
`settleChild`/`onChildResult`/`workerSettlement` symbol anywhere in the package.
So `record.ts`'s note is accurate — wiring `applyWorkerSettlement` today would mean
**inventing a caller rather than connecting a real one**, which would replace one
false claim ("enforced") with a worse one ("wired"). Reported, not faked.

**This is strictly stronger than "the epoch field is inert",** and it is the honest
half the coordinator asked for: because the only importers are tests, the product
does not reconcile unknown outcomes AT ALL. See §3 for what that does and does not
mean for the replay constraint.

---

## 3. Deliverable 2 — unknown effects must never be auto-replayed

**Verdict: PASS, by measurement, at both the ledger layer and the reachable service
layer. But the constraint holds BY OMISSION, not by enforcement, and that
distinction is the finding.**

### 3.1 The ledger layer (`effects.ts`)

The dangerous scenario is measured directly: the remote **commits**, then the reply
is lost, so `perform` throws. A replay would duplicate a real external effect.

| Measurement | Value |
|---|---|
| `perform` #1 — `performed` | `true` |
| `perform` #1 — `outcome` | `unknown` |
| recorded status after #1 | `unknown` (a resting state, not a retry trigger) |
| `perform` #2 — `performed` | `false` (it reconciled) |
| `perform` #2 — `outcome` | `confirmed` (established from the remote) |
| **transport invocations after 2× `perform` + 1× `reconcile`** | **1** |

The send-decision table is exhaustive over the closed status vocabulary, and the
result is that exactly two states license a send:

| Recorded status | send? | Why |
|---|---|---|
| `absent` | **yes** | nothing was ever recorded |
| `intent_recorded` | **yes** | the `sent` marker is written BEFORE the transport call, so its absence proves the call was never made |
| `sent` | no | invoked, no outcome; unknown is a resting state |
| `unknown` | no | a resend would be a guess about whether the first one landed |
| `confirmed` | no | already confirmed; a resend would duplicate it |
| `not_started` | no | even a positive "nothing happened" is not a licence — resending is a new authorization |

Both licensing states are proofs about **our own write ordering**, not about the
remote. That is what makes the rule checkable rather than aspirational.

The strongest form: an adapter with neither an idempotency key nor a queryable
result is **never invoked** — 0 transport invocations, recorded `unknown` (not as a
clean failure a caller might retry).

### 3.2 The reachable service layer (`host.ts`)

`EffectLedger` has no production importer (§2), so the constraint was also measured
on the path the product actually runs. A launch port that throws *after* the
request was written (child may exist):

| Measurement | Value |
|---|---|
| drain #1 outcome | `accepted: false`, reason `launch_failed_unknown` |
| task state | `unknown` (quarantined, **not** failed) |
| `budget.reserved` | **7 — held**, because the child may exist |
| `terminalTombstones` | `[]` — the task is not closed |
| drain #2 (the replay opportunity) | refused: `task "t1" is already admitted as unknown` |
| **launch attempts after both drains** | **1 — no replay** |

### 3.3 The honest limit — the constraint is not enforced, it is unreached

`T9-A`'s `G-SEAM-21c` measures that `reconcile.ts` and `effects.ts` are reachable
only from test files. The asymmetry, stated rather than asserted:

- the product **cannot** auto-replay an unknown effect, because nothing in it
  reaches `reconcileTask` (whose every uncertain branch returns `unknown`) or
  `EffectLedger.perform` (whose only send-licensing states are proofs about our own
  write ordering);
- but it also **cannot refuse to**, because refusing is a decision the absent
  caller would have made. An unknown outcome is left in the record and no
  production path resolves it.

**So "unknown effects are never auto-replayed" is currently true by omission, not
by enforcement, and must not be reported as a property the product enforces.** The
distinction matters because the two failure modes are different: a product that
enforces the rule refuses a replay loudly; this one simply never gets that far.

**A second honesty note on the scope of §3.2.** That measurement reaches `drain`
through the service API, which is correct for what it claims — it measures what the
service does. But `WorkService.createRun` itself has **no production caller**
(measured: only `durability-runner.ts`, the hand-run CLI). That is G-SEAM-31, a
separate open gate in `docs/GAPS.md` owned by another agent, and it means the
`drain` path is not reachable by any user action today. §3.2 measures the mechanism;
it does not claim a user can reach it.

---

## 4. Deliverable 3 — `attempt_status` and `effect_status` are SEPARATE

**Verdict: PASS.** No `safe_to_retry` predicate exists anywhere in the repository,
so the question "is it computed as *idempotent AND the effect definitively did not
happen*" has a measured answer: **there is nothing to get wrong, and also nothing
that can refuse on a caller's behalf.**

The separation is measured with a scenario where the two statuses provably differ —
the remote committed and the call still threw:

| Fact | Field | Value |
|---|---|---|
| the ATTEMPT happened | `performed` | `true` |
| the attempt established no outcome | `outcome` | `unknown` |
| the EFFECT in fact committed | `reconcile().outcome` | `confirmed` |
| the stored EFFECT status | `record.status` | `confirmed` |
| the separate ATTEMPT count | `record.attempts` | `1` |

`record.status` and `record.attempts` are distinct fields, so the record cannot
conflate them. Deriving one from the other would be wrong in exactly this case and
right nowhere that matters.

The nearest predicate that does exist is `mayRunAutomatically`, and it is a
**refusal device**: only `read_only` passes, so `unknown` — the classification that
would tempt a caller to retry — is refused.

---

## 5. The failing test I was sent to fix: the assertion was inverted

`T9-B: the rehearsal's fixture defect is real` failed with
`expected true to be false`. **The fixture was malformed exactly as claimed, and
the assertion was wrong.** The record shape had not changed.

The old assertion was `expect(Object.hasOwn(stored, 'status')).toBe(false)` on the
object returned by `ledger.get()`. Measured, that object has **12 own keys and
`status` IS one of them** — with the value `undefined`:

```
IN-MEMORY own keys      = operationId,kind,logicalKey,parameterDigest,parameters,
                          status,attempts,detail,toolCallIds,refusedDigests,
                          intentRecordedAt,updatedAt
IN-MEMORY hasOwn status = true
IN-MEMORY status value  = undefined
```

The mechanism is `send` (`effects.ts:868-875`): it spreads `status: result.status`,
and `result.status` is `undefined` because the broken fixture returned
`{ kind: 'accepted' }`. Spreading an `undefined` **creates the key** — it does not
omit it. So the in-memory object has a `status` key whose value is `undefined`.

The persisted document is where the key genuinely disappears, because JSON has no
representation for `undefined`:

```json
{ "operationId": "eff_08b7…", "kind": "t9b-defect", "logicalKey": "k", …,
  "attempts": 1, "detail": "", "toolCallIds": [], … }
```

(no `status` key; the file is `dsh_daily_effects.json` in the store root)

**The fix asserts both facts at their correct layer** — the key exists in memory
with an `undefined` value, and the key is absent in the persisted artifact that the
next generation actually validates. The load-bearing claim is unchanged and now
correctly located: a second generation over that directory is refused with
`domain 'dsh_daily_effects': stored record '…' in table 'operations' does not match
its schema`, which the test still asserts.

Why the original error was easy to make and worth recording: the rehearsal's prose
said the stored record "has NO `status` key". That is true **of the file** and
false **of the object the test had in hand**. Asserting the prose against the wrong
artifact produced a failure that looked like a fixture problem.

---

## 6. Pre-existing failures NOT owned by this run

The whole-file run reports 2 failures, both in `T9-C: FILESYSTEM gates FS-01..FS-06`
(owned by agent T2 — the CRLF / raw-Python cases):

- `FS-05: line endings are preserved through an edit, so a CRLF file stays CRLF`
  → `expected 'x\ny\nz\n' to be 'x\r\ny\r\nz\r\n'`
- `FS-06: a raw Python mutation is visible to the verifier from the world`
  → `expected '…\r\n' to be '…\n'`

**These are not caused by this run, and that is measured rather than asserted.** The
`T9-C` region is byte-identical between HEAD and the working copy:

```
$ sed -n '/^describe(.T9-C/,$p' <HEAD version>          | sha256sum
776a05c34efb8ce7056e091ea402493af41ed3327c9c8db013c3fc56369cf632
$ sed -n '/^describe(.T9-C/,$p' src/durability-advanced.test.ts | sha256sum
776a05c34efb8ce7056e091ea402493af41ed3327c9c8db013c3fc56369cf632
```

The diff hunks for this run touch only lines 48, 898-1068, 1321-1455 and 1456-1733;
`T9-C` begins at line 1756 in the working copy and is untouched. Both failures look
like the same Windows CRLF-vs-LF issue in a single family and are left to T2.

---

## 7. Instrument note — the import-graph walk, and a bug worth keeping

The `T9-A` walk is the standing check in `docs/GAPS.md` ("The defect class this
project kept producing"), applied as a test rather than as a one-off scan. Two
things about it are load-bearing:

**It walks in the correct direction.** The first version walked *importer* edges
from the entry points, which answers "which modules import an entry point" — a
different question. It reported `recovery.ts` as reachable, because `recovery.ts`
imports `host.ts` and `host.ts` is itself an entry point. The fix walks *import*
edges (what an entry point reaches), and the `host.ts` positive control is what
catches this class of error: a broken traversal returns an empty set, and an empty
set makes every `toBe(false)` assertion pass for the wrong reason.

**It is deliberately not a regex over source text alone.** R3's `FINDINGS.md` §1
records that a naive single-line regex missed multi-line imports and produced both
false negatives and a false positive. This gate's regex (`/from\s+'(\.[^']+)'/gu`)
does span newlines and was cross-validated against R3's `ts.preProcessFile`-based
scan; both agree on `recovery.ts`. The remaining difference between the two is
scope, not correctness: R3 restricts its importer map to the reachable subgraph, so
it never visits the unreachable CLI, while this walk reports
`durability-runner.ts` as `reconcile.ts`'s one non-test importer. The test asserts
both halves separately — the importer exists, AND that importer is itself
unreachable — because collapsing them would repeat the "presence is not
reachability" error this gate exists to catch.

The coordinator asked whether this should be recorded as a reusable instrument
rather than a one-off test. It should: `T9-A`'s first two cases are
package-agnostic, and `docs/GAPS.md`'s standing check is currently prose that each
agent re-implements (R3 wrote a `.mjs` scan; this run wrote a vitest case; they
disagree on one module for a scope reason). A single checked-in instrument would
remove that divergence.

---

## 8. What this run did NOT establish

| Not established | Why |
|---|---|
| That the epoch guard is fixed | It is **not** fixed. Wiring it needs a `transition` signature change plus a real settlement ingress that does not exist. Reported as instance 3 of the defect class, still OPEN. |
| That unknown effects are never replayed *because the product enforces it* | The constraint holds **by omission** (§3.3). The product never reaches the reconciler, so it neither replays nor refuses. |
| That a user can reach the `drain` path measured in §3.2 | `createRun` has no production caller (G-SEAM-31, another agent's gate). §3.2 measures the mechanism, not user reachability. |
| That `T9-C`'s 2 failures are benign | Not investigated — another agent's block, byte-identical to HEAD. They are reported, not diagnosed. |
| Any cross-process stale-generation refusal | Not covered by any reachable code path. `record.ts` notes that the in-process case IS covered by `tool-protocol-guards.ts` comparing the registry entry by object identity. |
