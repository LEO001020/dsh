# S9 — CAP-10: a completion storm neither duplicates nor misses a top-up

Worktree `D:\DSH\work\wt-s9`, branch `wt/s9`. Source digests in
`source-digests.txt`. All numbers below were measured on this tree; the commands
are in each section.

Oracle (v2, verbatim): *"Have many children complete within one event-loop
interval."* — *"No duplicate launch, no overshoot past the target, and no missed
replacement; the coalesced drain is shown to be re-triggerable. The exact launch
count is recorded."*

---

## 1. THE LEADING RESULT: the R4 "1 admitted → 0" measurement

**Verdict: the MECHANISM is real and reproducible; the PRODUCT PATH does not
reach it. R4's measurement is a true fact about two writes at one key, and it is
NOT a lost admission in the live authorization path.**

### 1a. The mechanism, reproduced exactly as R4 measured it

`before-overwrite-mechanism.txt` — two `createRun` calls at the SAME run key,
with one admitted task between them:

```
S9/9 OVERWRITE: tasksBefore=1 tasksAfter=0 ref="...commandId=cmd-B..."
S9/9 PRODUCT:   created=false tasksBefore=1 tasksAfter=1 ref="...commandId=cmd-A..."
```

So the destructive half is real: `createRun` ends in `runs().put(runId, record)`,
`put` is an unconditional insert-or-overwrite, and the second write replaces the
whole record — task rows included. That is R4's `1 → 0`.

### 1b. The product path does not do that, and the serializer holds at K ≥ 3

`authorizeRun` is the only product entry point (`command-work.ts:252`), and it
runs its check-and-create inside `serializeAuthorization`. Measured across
K = 2, 3, 4, 8, 16 concurrent calls, in one event-loop interval, both COLD (no
run) and WARM (one admitted task on the run):

`before-1to0.txt`

```
S9/1->0 K=2  runs=1 claimedCreated=0 claimedExisting=2 tasksBefore=1 tasksAfter=1
S9/1->0 K=4  runs=1 claimedCreated=0 claimedExisting=4 tasksBefore=1 tasksAfter=1
S9/1->0 K=8  runs=1 claimedCreated=0 claimedExisting=8 tasksBefore=1 tasksAfter=1
S9/COLD K=2  runs=1 claimedCreated=1
S9/COLD K=4  runs=1 claimedCreated=1
S9/COLD K=8  runs=1 claimedCreated=1
S9/COLD K=16 runs=1 claimedCreated=1
```

`tasksBefore=1 tasksAfter=1` at every K: no admitted task is destroyed, and the
authorization ref is never replaced. **K ≥ 3 was worth testing separately**
because a two-call interleaving can pass by luck; it does not here.

### 1c. Why this is a correct refusal and not a silent zero

The 1 → 0 case is not "an admission path that admits zero tasks under a race".
It is two DIFFERENT objects being confused:

- `createRun` is a raw record-write primitive. It has no duplicate guard by
  design, and calling it twice at one key is an overwrite — correctly so, since
  it is the primitive that writes a record for the first time.
- `authorizeRun` is the authorization edge. It observes an existing run and
  returns `created: false`, which is V3 §I2's required idempotence.

So the honest reading of R4's measurement is: **the derived id made a silent
duplicate into a certain overwrite (strictly worse, as R4 said), and the
serializer is what makes the product path safe.** The residual risk is bounded
and already recorded: the serializer covers ONE host process, and a second host
over one store is refused by the home lock, not by this chain
(`homelock.ts`, gate D-02).

---

## 2. THE DEFECT THIS SLICE FIXED: a missed top-up in the ordinary trigger

### 2a. BEFORE — the storm admitted ZERO replacements

`before-storm-miss.txt`, target 10, four releases and four refills issued in ONE
event-loop interval:

```
S9/7 concurrent: admitted=0 reasons=["none","none","none","none"] held=6 highWater=10
S9/7 VERDICT: PRE-CHECK refused (host slot never taken)
```

`highWater` stayed at 10 while the gate was never asked to admit, which is the
proof that the refusal came from `runDrainPass`'s read-only pre-check and the
authoritative reservation never ran. Cause isolation
(`before-cause-isolation.txt`):

```
S9/4A via drain():              admitted=0 held=6 deficit=4
S9/4C control (releases first): admitted=4 of 5 held=10 overshoot=0
S9/4D later drain:              admitted=1 held=7 deficit=3
```

The control admits exactly the freed slots, so the difference is the
INTERLEAVING and not the arithmetic. `4D` shows the miss is recoverable by a
later call — which is why it survived this long, and why "recoverable" was not
good enough: the trigger that matters is the completion itself.

### 2b. Why the pre-check existed, and why removing it is not a trade

It existed for a real reason. `tryReserveAdmission` took the host-wide slot
BEFORE the record write and released it on refusal, so a refused attempt bumped
the gate's `highWater` to `target + 1`; `capacity.test.ts` "ONE completion
refills while TWO siblings are still ACTIVE" caught that as a regression.

The fix removes the tension instead of choosing a direction: **the host-slot take
moved INSIDE the transform, after every refusal.** A refusal now happens before
any slot is taken, so it cannot move `highWater` at all, and no pre-check is
needed. Both `capacity.test.ts` highWater arms stay green under the new mechanism
(42/42, `after-capacity.txt`), which is the evidence that no direction was traded.

### 2c. AFTER

`after-cap10-storm.txt`, and the fix-verification sweep at target 10 for
freed ∈ {3, 5, 10} with `freed + 2` concurrent refills:

```
target=10 freed=3  requested=5  admitted=3  held=10 overshoot=0 deficit=0 highWater=10
target=10 freed=5  requested=7  admitted=5  held=10 overshoot=0 deficit=0 highWater=10
target=10 freed=10 requested=12 admitted=10 held=10 overshoot=0 deficit=0 highWater=10
control (releases first): admitted=5 of 7 held=10 overshoot=0
```

Never more than the freed slots, never fewer than the freed slots, `highWater`
never above the target, and the control agrees.

---

## 3. THE SECOND DEFECT, FOUND WHILE FIXING THE FIRST

Routing every duplicate through the reservation exposed it.
`ChildAdmissionGate.reserveTask` is idempotent per task id: for a task id it
already tracks it returns a handle to the EXISTING entry rather than taking a
second slot. The cleanup released that handle on every non-committing path, so a
duplicate `drain` for an already-admitted task was correctly refused and then
gave back the WINNER's slot:

```
S9/8A late duplicate: accepted=false reason="task \"task-0\" is already admitted as accepted"
S9/8A AFTER the refusal: gateOccupied=0 recordHeld=1
```

The ledger read `occupied 0` while the record still held one admitted task — the
host believed it had a free slot for a child that already existed, which is the
OVER-admission direction of INV-C1 reached by a duplicate notification rather
than by a race. Fixed by releasing only when THIS call took the slot (`tookSlot`
at `host.ts:1540`/`:1611`/`:1627`), which is set on the transform's take path and
nowhere else. Pinned by the two `CAP-10/duplicate` arms.

### 3a. A guard that was written, measured to be unreachable, and removed

The first version of the fix added `ChildAdmissionGate.hasTask(taskId)` and
`tookSlot = !alreadyTracked`, on the theory that a re-reserve could return an
existing entry and license a wrong release. **Mutation F (setting
`tookSlot = true` unconditionally) did NOT turn any test red**, which is what
prompted checking reachability rather than assuming it: a duplicate submission is
refused at step 2 of the transform (`already admitted as ...`), which is ABOVE
the take, so the gate and the record agree on which tasks hold slots and the
idempotent-re-reserve case cannot arise. The guard and the `hasTask` accessor
were DELETED rather than kept, and `capacity.ts` is byte-identical to its
pre-slice state (`source-digests.txt` records that `git diff` is empty for it).

This is recorded because the alternative — shipping a dead guard with a comment
claiming it prevents a defect — is precisely the defect class this project has
recorded repeatedly (a comment asserting a property the code does not have,
G-SEAM-55/G-SEAM-67). The reachability argument is now in the code comment at
the take site instead of a guard that never fires.

---

## 4. THE RESIDUAL, STATED PLAINLY

The storm arm admits 5 of 6 in one interval and reaches exactly 6 after one
re-trigger (`admittedInStorm=5 deficitBeforeRetrigger=1 admittedOnRetrigger=1
heldFinal=6`). That is CORRECT behaviour, not a leftover miss, and the reason is
worth recording so a later reader does not "fix" it:

- A top-up that arrives BEFORE its slot is free is refused by the gate. At the
  instant its transform ran, the slot really was occupied.
- Nothing in this package re-triggers a drain when a child settles. There is no
  `subagent/end` listener, and **no non-test writer of `settling` or `confirmed`
  exists anywhere in the tree** — verified by `grep` over the whole repository
  excluding tests and `lib/`. The only production writer of a slot-releasing
  transition is `transition(...)` reached from `runDrainPass`'s own
  post-reservation path.
- So the top-up trigger is the ROOT ASKING. The oracle's "no missed replacement"
  is satisfied in the sense that a freed slot is never lost: the next top-up
  admits it. It is NOT satisfied in the stronger sense of "a completion
  automatically produces a replacement with no further call", and this slice
  does not claim that.

**This is reported as the residual of this slice, not fixed**: inventing a
settle-driven trigger is a new product mechanism, and the project's rule is that
an invented producer is a fabrication.

---

## 5. MUTATION TESTS

Each mutation was applied to `src/host.ts`, the named command run, and the file
restored to the digest in `source-digests.txt` (verified with `sha256sum`).

| mutation | what it breaks | result |
|---|---|---|
| B: restore the pre-fix read-only pre-check | the miss direction | `mutation-B-prefix-precheck-storm.txt` — storm, sweep and retrigger arms RED: `expected 0 to be greater than 0`, and `freed 3: every freed slot is refilled: expected [] to have a length of 3 but got +0` |
| C: release the host slot unconditionally again | the duplicate direction | `mutation-C-unconditional-release.txt` — both duplicate arms RED: `expected +0 to be 1` |
| D: decide the target from an OUTSIDE snapshot (check-then-act) | atomicity | `f5-independent-mutation-check.txt` — R3's `f5-admission.test.ts` RED: `expected [8 reservations] to have a length of 3` |
| E1: defeat the target comparison entirely (`held >= target` → always true) | the whole target gate | `mutation-E1-defeat-target-comparison.txt` — R3's suite 18 of 20 RED |
| E3: hoist the occupancy read outside the update, keeping the inside comparison | atomicity, the pre-fix shape | `mutation-E3-check-then-act.txt` — R3's `WITH THE COALESCER DEFEATED` arm RED (1 of 20) |

Mutation D is the independent verification of F5 that this slice owed: the
atomicity claim was tested by breaking it, not by trusting R3's green suite.

**Three mutations did NOT falsify their gate, and they are recorded rather than
dropped**, because a mutation that cannot fail its gate is itself a finding
about the gate's sharpness:

- `mutation-E2-outside-read-dominated.txt`: reading occupancy outside the update
  but keeping the inside comparison green. This is not a real atomicity break —
  the outside read is still evaluated at the transform's queue slot, so the
  comparison remains serialized. It is kept as the negative control that shows
  E3, not D, is the mutation that models the pre-fix shape.
- `mutation-A-nonatomic-storm.txt`: an outside-snapshot target decision that the
  storm test did NOT catch (`admittedInStorm=4` instead of 5, but the
  re-trigger still converged to the target). The storm test's convergence
  property is deliberately insensitive to a LOST slot — it is sensitive to a
  ZERO-admission storm, which is the measured defect. `mutation-E3` is what
  catches the check-then-act shape, through R3's suite.
- **mutation F** (`tookSlot = true` unconditionally, i.e. dropping the
  `alreadyTracked` refinement): no test turned red. Investigated rather than
  ignored, and it is why the guard was DELETED — see §3a. Recorded here because
  a mutation that changes nothing is evidence about reachability, not a gap in
  the test.

---

## 6. COMMANDS AND RESULTS

```
node node_modules/vitest/vitest.mjs run src/cap10-storm.test.ts       ->  7 passed
node node_modules/vitest/vitest.mjs run src/f5-admission.test.ts      -> 20 passed
node node_modules/vitest/vitest.mjs run src/capacity.test.ts          -> 42 passed
node node_modules/vitest/vitest.mjs run src/capacity-v8-probe.test.ts ->  4 passed
node node_modules/vitest/vitest.mjs run src/concurrency.test.ts       ->  9 passed
node node_modules/vitest/vitest.mjs run src/scheduling.test.ts        ->  9 passed
node node_modules/vitest/vitest.mjs run src/host.test.ts              -> 21 passed
node node_modules/vitest/vitest.mjs run src/isolation.test.ts         -> 39 passed
node node_modules/vitest/vitest.mjs run src/authorization-path.test.ts -> 33 passed + 1 expected fail
node node_modules/vitest/vitest.mjs run src/dep-gates.test.ts         -> 37 passed
node helpers/typecheck.mjs                                            -> PASS (both packages)
```

---

## 7. WHAT IS NOT CLAIMED

1. An in-process storm is not a storm across OS processes. Every arm here runs
   in ONE Node process; the storage-domain write chain is per-DOMAIN and
   in-process, so a second host sharing the store is outside what this slice
   measures (the home lock refuses that configuration, it does not serialize it).
2. An in-process storm is not a real model turn. The provider is scripted; the
   loop, the registry, the Sessions and the domain are real, but no real model
   produced a completion.
3. No settle-driven automatic top-up is claimed, for the reason in §4.
4. The R4 1 → 0 measurement is not claimed to be reachable from the product
   authorization path; it is claimed only for two writes at one key (§1).
