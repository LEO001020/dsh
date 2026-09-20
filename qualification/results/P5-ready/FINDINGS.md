# P5 — WORK-READY / WORK-ROLLING / WORK-N30 / WORK-MULTIROOT

Slice: V5 §7 in full, plus §18's four oracles. Worktree `D:\DSH\work\wt-p5`,
branch `wt/p5`, base `2e1b2c2` (`2e1b2c2d3657407ce7ac621b07b3307d3edd8df4`).

Step 1's source map is `STEP1-SOURCE-MAP.md` in this directory. It is the
reconnaissance this slice was built from, and it is committed separately
(`3ec71e5`) so a reader can check the map against the implementation.

---

## 1. THE TWO GAPS, RE-VERIFIED BEFORE ANY CHANGE

**Gap 1 — no completion-driven refill. CONFIRMED, and it is worse than "no
listener".**

- `SOURCE_FACT`: `grep -rn "subagent/end" packages/dsh-daily-work/src/*.ts`
  excluding tests returned **nothing**. The only occurrences in the repository
  were three test-only observers (`cap10-storm.test.ts:226`,
  `lifecycle.test.ts:101`, `scheduling.test.ts:238`), each pushing into a local
  array.
- `PROJECT_FACT`: S9 recorded the consequence itself
  (`qualification/results/S9-cap10/FINDINGS.md:186-193`): *"Nothing in this
  package re-triggers a drain when a child settles... So the top-up trigger is
  the ROOT ASKING."*
- **THE MECHANISM, WHICH IS THE FINDING.** A missing listener alone would mean
  "refill is late". What was actually true is stronger: `SLOT_HOLDING_STATES`
  contained `settling` (`states.ts`), and **no production code ever wrote
  `confirmed`** — so a task that reached `accepted` held its slot forever.
  Occupancy was **monotone non-decreasing in production**, and every child
  permanently reduced N by one. That, not a missing timer, is why rolling N did
  not roll.
- I did not have to infer this. `reconcile.test.ts` already carried an arm named
  *"PRODUCT PATH: a launched child never leaves `accepted`"* — the measurement
  existed and the consequence had not been drawn.

**Gap 2 — `work submit` is not durable. CONFIRMED.**

- `SOURCE_FACT`: `tools.ts:156-176` called
  `service.drain(runId, [{taskId, childId, prompt: goal, reservedCost: 1}], signal)`
  immediately. A refusal is a VALUE and **writes nothing** — deliberate, so a
  refusal storm is free (`host.ts`, "A REFUSAL WRITES NOTHING"). So at a full
  target the `goal` string existed only in the tool-call argument and was lost.
  The tool then reported `accepted: false` with a `reason` and no `taskState`.
- The consequence is exactly what V5 §7 names: the root had to re-derive the
  semantic task after every completion, turning a mechanical target into model
  polling.

---

## 2. WHAT WAS BUILT, AND WHY EACH SHAPE

### 2.1 A durable READY table, not a `ready` state (§7.1)

V5 §7.1 permits either. I took the table, for three reasons recorded at
`record.ts`'s `readyAssignmentSchema`:

1. `holdsSlot` over `ADMISSION_STATES` is INV-C1's single predicate and
   `heldSlots` is the ONE occupancy derivation shared by the admission gate and
   the deficit reader. A non-slot-holding member of that vocabulary is a value
   whose only correct behaviour is to be excluded everywhere — one forgotten
   exclusion and a READY assignment consumes a child slot, which is what §7.1
   forbids.
2. `taskRecordSchema` requires `attempt >= 1`; a ready assignment has no attempt,
   because it has not been admitted.
3. §7.1's field list (submission sequence, source-call correlation) is intent
   metadata, not admission metadata.

The record carries §7.1's full list: `taskId`, `childId` **reserved at
submission** (so a crash before admission names the child a later admission must
create, rather than minting a new identity), `prompt`, `assignmentDigest`,
`reservedCost`, `allowedCapabilities`, a monotone `sequence`, `createdAt`, and an
optional `sourceCallId`. It holds no slot and commits no credit.

### 2.2 Submission is durable; admission is a separate question (§7.2)

`submitReady` inserts and **does not admit**. The duplicate rule is both halves
§7.2 names:

- identical assignment under the same `taskId` → **idempotent**, and the
  transform returns the record UNCHANGED so the domain performs no write at all;
- changed assignment under the same `taskId` → `ReadyConflictError` naming both
  digests.

The sequence is `max(existing)+1`, not `count+1`: `count+1` reuses a number after
an admission, making "oldest ready" ambiguous, which is a starvation risk rather
than a cosmetic issue.

`work submit` now reports `ready` and `accepted` **separately**. `ready: true,
accepted: false` is the reading that did not exist before, and it is the whole
point: the work is safe and will run when a slot frees.

### 2.3 One leader, reused — not a second controller (§7.3)

`requestDrain` is a **wake**, not a request: it takes no work of its own and
reuses the SAME per-run leader and generation/dirty loop as `drain`. A second
leader map would be two leaders racing on the same slots — the exact defect
CAP-10 measured. Correctness is untouched and still lives in
`tryReserveAdmission`'s single storage-domain update (V5 §21).

A ready-driven pass reads the table at pass start, oldest first, and on a
capacity refusal **breaks** (§7.3's pseudo-code). The exception is
`slots_held_by_unconfirmed`, which is the ROW's own staleness: that row is
dropped and the pass continues, because breaking there would let one stale row
block every row behind it.

### 2.4 The state that makes rolling possible — and the design decision it forced

This is the substantive change of the slice, and my first draft got it wrong.

Writing `settling` on completion looked right (work appears done, unverified) and
**the rolling arms failed**: the refill never happened, because `settling` holds
its slot. The failure was informative, and the fix is a new state.

`completed` carries exactly one fact: **the child's ACTIVATION is over, so the
slot is free.** It deliberately does NOT carry "the result is the work that was
asked for" — that remains `confirmed`, acceptance's judgement. A listener that
wrote `confirmed` would make the child the oracle for its own work, which is the
inversion the verification gate exists to prevent. The two facts are both true
and are now both representable.

Three properties that are load-bearing and were chosen deliberately:

- **NOT terminal.** It transitions to `confirmed`/`unknown`/`cancelled`. A
  terminal state could never be judged, which would trade one dead end for
  another. (`TERMINAL_STATES` is unchanged: `confirmed`, `cancelled`.)
- **It does NOT release the budget reservation.** The child ran and spent money
  nobody has measured; `transition`'s own default release rule
  (`confirmed`|`cancelled`) is already the safe direction, so it is relied on
  rather than restated. Slot and credit genuinely diverge here.
- `countRun` reports `completed` **separately from** `confirmed`. A reader that
  summed them would read unverified work as success.

### 2.5 `subagent/end` as a mechanical wake only (§7.4)

`completion.ts` reads the payload for **identity and `stopReason` only**. It
never reads `lastAssistantMessage`, because DSH's manager owns parent delivery
and a second delivery path is what §7.4 forbids.

The stop-reason branch is an **allow-list of the one reason that establishes
completion** (`'completed'`), read from DSH's own `SubagentStopReasonMap`
(`dsh-subagent/src/types.ts:252-266`: `completed`, `aborted`, `error`,
`max-tokens`, `refusal`). My first draft listed failures and treated everything
else as success — **two of the five names it used do not exist in the real
vocabulary**, and the shape was wrong in the dangerous direction: a future
variant would have been read as a successful completion. `max-tokens` is not
completion and is the case most likely to be got wrong.

A failure `stopReason` writes `unknown` with the reason as its uncertainty, and
**no retry task is invented** — §7.4's instruction, expressed as state rather
than prose.

The listener is now mounted by `host-plugin.ts`, so it has a production call
site. Before this slice, that was the thing that did not exist.

### 2.6 Boot/recovery (§7.5)

`sweepOpenRuns` does all four clauses: enumerates non-closed runs, reports every
slot-holding task with whether a live Agent backs it, **launches nothing**, and
wakes runs holding READY assignments. There is no `port.launch` call in it and
there must never be one.

Waking a ready run from a **portless** boot is safe because the ready-driven pass
refuses without a port and leaves the table intact — so the sweep cannot convert
pending intent into `unknown` tasks that would hold slots and commit credit. That
interaction is what makes the sweep callable from the plugin's `apply`, where no
root Agent is in hand.

---

## 3. MEASUREMENTS

### 3.1 New arms

| suite | arms | result |
|---|---|---|
| `src/ready-assignments.test.ts` | 10 | 10 passed |
| `src/rolling-n.test.ts` | 10 | 10 passed |
| `src/boot-sweep.test.ts` | 4 | 4 passed |

The rolling arms are the ones that matter, and the claim they establish is
ORDERING, not timing: **each arm submits once, wakes once, and then never calls
`drain`, `requestDrain` or `submitReady` again.** Every later admission comes
from a real `subagent/end` emitted by the real registry. A test that called
`drain` once per completion could not distinguish "refill when called" from
"sustain N", which is precisely the distinction S9 recorded as its residual.

Measured, with real children (production AgentLoop, real continuable registry,
real in-process spawn provider, a real JSONL Session each; only the model adapter
is controlled, which is the provider boundary and not a second loop):

- **N=1**: one completion starts the replacement; the replacement is the next
  READY row.
- **N=1**: the whole table drains one completion at a time, in submission order,
  with no wave barrier.
- **N=30 from 62 READY**: occupancy reaches exactly 30, `targetOvershoot` 0, 32
  assignments remain durably pending, consumed oldest-first.
- **N=30 rolling**: five children released → five replacements with no further
  work call; replacements are the five OLDEST remaining assignments;
  `completed` 5, `confirmed` **0**.
- **N=30 → N=1**: all thirty children still live (`listChildren` 30),
  `targetOvershoot` 29, a completion admits nothing while above target, and the
  freed slot is still visible as a real reduction to 29.
- **MULTIROOT**: two runs at target 25 each through ONE service admit 30 in
  total against a combined demand of 50, and BOTH make progress.
- **insufficient ready work**: honest deficit (`insufficient_ready_tasks`), no
  filler task invented.
- **portless wake**: the table is left intact; no `unknown` task is created.

V5 §21 makes N=30 a **product contract, not a performance claim**, so these arms
assert occupancy and ordering only. No arm would become false on a machine ten
times slower, and no number is compared against a figure from a paper.

### 3.2 Mutation verification — every load-bearing arm, watched failing first

| mutation | what it restores | caught by |
|---|---|---|
| **A** `sequence` always 1 | the ordering is not durable | 1 of 10 in `ready-assignments.test.ts` |
| **B** duplicate rule deleted | silent replace / silent keep | 4 of 10 in `ready-assignments.test.ts` |
| **C** `completed` added to `SLOT_HOLDING_STATES` | **the pre-fix tree's behaviour** | 4 of 10 in `rolling-n.test.ts` |
| **D** observer writes `settling` | my own first draft | 4 of 10 in `rolling-n.test.ts` |
| **E** listener not mounted | **gap 1, exactly as it was** | 4 of 10 in `rolling-n.test.ts` |

C and E are the important ones: each restores a state this repository actually
had, and each turns the rolling arms red. The arms therefore measure the defect,
not a description of it.

### 3.3 Regression surface

| suite | result |
|---|---|
| `states.test.ts` | 21/21 |
| `capacity.test.ts` | 42/42 |
| `concurrency.test.ts` | 9/9 |
| `scheduling.test.ts` | 9/9 |
| `cap10-storm.test.ts` | 7/7 |
| `f5-admission.test.ts` | 20/20 |
| `cost.test.ts` | 43/43 |
| `reconcile.test.ts` | 18/18 |
| `host.test.ts` | 21/21 |
| `production-port.test.ts` | 2/2 |
| `durability-records.test.ts` | 25/25 |
| `durability-advanced.test.ts` | 33/33 |
| `isolation.test.ts` | 39/39 |
| `authorization-path.test.ts` | 33 passed + 1 expected fail |
| `plugin.test.ts` | 9/9 |
| `capacity-v8-probe.test.ts` | 4/4 |
| `node helpers/typecheck.mjs` | **PASS**, 98 files, exit 0, escape-hatch 3/3 |

---

## 4. TWO THINGS THE GATES CAUGHT, AND ONE I GOT WRONG

These are recorded because a clean report that omits its own corrections is the
shape this project keeps recording.

1. **The ID-05 escape-hatch gate refused my first `isChildLive`** — a non-test
   `as never` grew the count 3 → 4. The gate is right, and the fix is the seam's
   own `SessionId(...)` brand constructor (the same one `launch-port.ts:78` mints
   the id with), so the brand is PRODUCED rather than asserted. No baseline edit.

2. **My first boot arm asserted a `closed` run is skipped.** That was wrong:
   nothing in production writes the `closed` phase, so the arm would have needed
   a private path to fabricate a state the product cannot produce — an oracle
   measuring something other than the product. It now asserts §7.5's actual
   wording (open/paused/**closing**) through the real `beginClosing`.

3. **My first "honest deficit" arm expected `deficitReason:
   'slots_held_by_unconfirmed'`.** The real answer is
   `'insufficient_ready_tasks'`, because the reader consults the ready count
   BEFORE the held-slot reading. The real answer is the more specific and more
   useful one; the arm now asserts it with the correction noted at the assertion.

---

## 5. PRODUCT REACHABILITY

The shortest real path from a boot to this code:

1. `host-plugin.ts:39` `apply()` constructs `WorkService`, installs the target
   setting, and `open()`s the domain.
2. `host-plugin.ts:65` `service.installCompletionObserver()` mounts the
   `subagent/end` listener on the service's own context — **the first production
   listener this package has ever had**.
3. `host-plugin.ts:73` `service.sweepOpenRuns()` enumerates non-closed runs and
   wakes those holding READY assignments.
4. A human `/work start N` → `command-work.ts:226-278` → `authorizeRun` →
   `createRun` (`host.ts`), which binds the REAL launch port to the exact live
   root.
5. The model calls the `work` tool with `action: 'submit'` →
   `tools.ts:156` → `submitReady` (durable insert) → `requestDrain` (wake) →
   `runDrainPass` → `tryReserveAdmission` → `port.launch`.
6. A child ends → DSH emits `subagent/end` → `completion.ts` reconciles the task
   to `completed` (slot freed, credit retained) → `requestDrain` → the next
   oldest READY assignment is admitted, **with no further model call**.

Every link in that chain is a production call site. Steps 2 and 6 are the ones
that did not exist before this slice.

---

## 6. WHAT I AM NOT CLAIMING

1. **No live paid provider sustained 30 real children.** Every child here is
   scripted-adapter-driven. V5 §7.6's `UPG-07` arm (30 non-empty children on a
   frontier provider) is BLOCKED_EXTERNAL for lack of authorized budget, and no
   number in this file substitutes for it.
2. **No cross-process claim.** Every child is in-process. The `subagent/end`
   event is declared provider-independently, but the transport for an
   out-of-process provider is not exercised.
3. **No claim that `completed` is judged.** Nothing in this slice runs
   acceptance against a `completed` task. `confirmed` still has no production
   writer after this change, and a `completed` task whose work is never judged
   will keep its reservation as `reserved` forever. That is the same residual
   `GAPS.md` G-SEAM-68 records for `unknown`, narrowed but not closed, and it is
   reported rather than hidden.
4. **No timing or throughput claim.** The rolling claim is ordering.
5. **No claim about a second host sharing the store.** The single-writer
   configuration is a documented gate; nothing here relaxes it.
6. **`readyTaskCountFor` folds by MAXIMUM**, so a caller that sets a stale
   higher `readyTasks` through `setReadyTasks` still gets that reading. The
   direction is chosen because the number only EXPLAINS a deficit and
   over-reporting ready work can never hide a shortage — but it does mean
   `setReadyTasks` remains a way to state a ready count the record does not
   corroborate. It has no production caller.

---

## 7. UNRESOLVED UNKNOWNS

1. Whether the `completed` state should be reachable from `prepared` and
   `launching` (a child that never really started). It is currently reachable
   only from `accepted`/`executing`/`settling`/`unknown`. A completion event for
   a task in `launching` is silently ignored by `canTransition`, which is safe
   but means the slot is not freed in that window.
2. Whether a `completed` task should ever be auto-confirmed, or whether
   acceptance is expected to walk every `completed` task. Not in this slice's
   scope; §7 does not say, and inventing an answer would be inventing a second
   controller.
3. How a real `max-tokens` completion should be reported to the root. It
   currently lands in `unknown` with its stop reason recorded, which is honest
   but is not a semantic judgement.
4. Whether the N=30 arms' wall-clock (~0.8-1.6 s each) scales on a contended
   machine. They were run one file at a time per the CPU discipline; a full
   suite run is a different load.
