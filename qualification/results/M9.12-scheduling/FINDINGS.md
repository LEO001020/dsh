# M9.12 — scheduling gates C01, C02, C03, C04, C07, C09

Slice: the mandatory rolling child top-up, closed at the scheduling layer.
Case: `packages/dsh-daily-work/src/scheduling.test.ts` (9 cases, all passing).

## Tier of this result, stated first

`T1` — production DSH services and the production `AgentLoop` with a
**controlled (scripted) provider**. That is the tier definition this project
uses (`ACCEPTANCE.zh-CN.md:13`: "T1=production DSH services+mock provider";
`MASTER_EXECUTION_PROMPT.zh-CN.md:454-461`).

**C01 does NOT close at T5 and its gate status must not be promoted.** T5 is
"an authorized real provider with ten real children". The lock records
`live_provider_budget_authorized: false`, so the live paid N=10 run remains
`BLOCKED_EXTERNAL`. A T1 result is not a T5 result and this file does not claim
otherwise. What changed is that C01's **offline** half is now closed with a
recorded timeline rather than asserted.

## What is real in the rig

- the production `@deepseek-ai/dsh-agent-loop` (`AgentLoop`)
- the real `ctx.subagents` registry and its continuable machinery
- the real in-process spawn provider (`dsh-subagent-spawn-in-process`)
- a real durable JSONL Session per child (`dsh-session-persistence-jsonl`)
- the real storage domain over the JSON backend (`dsh-storage-domain`)
- the real `LaunchPort` under test (`src/launch-port.ts`)
- for C09, the real `@deepseek-ai/dsh-llm-mock-server` HTTP/SSE server **and**
  the real `@deepseek-ai/dsh-llm-retry` executor

Only the model adapter is scripted. That is the provider boundary, not a second
model loop: the loop, the tools, the inbox, the sessions, the subagent registry
and the admission machinery are all genuine.

## Per-gate result

### C01 — mandatory ten actually executing

**T1. PASS at T1; T5 stays BLOCKED_EXTERNAL.**

Twenty independent tasks are submitted against `target N=10`. Ten are admitted
and ten are refused with reason `none` (the ceiling holding, not a failure).
Ten **distinct** children each reach a real model request in their own durable
Session, and each is `status: 'running'` — not an idle placeholder. Each is a
genuine continuable child: `delegationDepthOf() === 1`, `origin: 'subagent'`,
`parentSession === root.id`.

Root exclusion is asserted twice, and the second case is the sharper one:

- In the main case the root issues **no** request at all, and that is checkable
  rather than assumed: no child settles, so no settlement message is ever
  delivered to it.
- In the second case one child is settled deliberately, which makes the root
  take a real turn of its own. The root's turn is attributable to the root's
  session, is never counted among the children, and leaves the ten held slots
  untouched. The partition is exact:
  `distinctSessions === children + rootSessions`.

That second case exists because the naive form of the root assertion is
**wrong**: DSH's continuation manager injects a settlement message into the
parent when a child ends
(`packages/subagent/subagent/src/continuation-activation.ts:870-880`,
`notifySettlement` → `parent.inject(message)`). "The root never calls the model"
is not a property of the system and must not be asserted; "the root's turns are
never counted as children" is.

### C02 — a single completion refills immediately

**T1. PASS at T1.**

Nine children stay held inside their model calls while one is released and
settles. The run record still holds the settled child's slot (only a confirmed
transition releases it), the other nine are still `running`, and confirming the
settled task frees exactly one slot which is filled by exactly one replacement.
The replacement reaches its own model request while the original nine are still
held, so the wave did not have to finish.

**Measured refill latency (recorded, NOT asserted against an SLO):**

```
+0ms   release child-0
+18ms  child-0 ended and left the registry
+18ms  slot freed by confirmation
+43ms  child-500 admitted            <- refill latency 25ms
+43ms  replacement reached a model request
```

Observed across runs: **refill latency 19–25 ms**; admitted → first model
request **0 ms**.

**No numeric SLO is asserted, deliberately.** The gate asks for a replacement
"within a frozen SLO". No SLO is frozen anywhere in this repository, so
asserting a bound here would make the test the author of the standard it is
being judged against. The number is recorded instead, and a human can freeze it
later against this measurement. This is the honest form of the gate at this
tier.

### C03 — completion storm

**T1. PASS at T1.**

Three concurrent drains are issued in one event-loop interval, then three slots
are freed in one interval and three more concurrent refill drains are fired.
Results:

- No duplicate launch: three freed slots admit exactly three children, one per
  slot, never four.
- No overshoot: occupancy never exceeds N. Checked against the **live**
  registry, not the durable listing (see the `listChildren` finding below).
- No missed refill: the coalesced drain is re-triggered afterwards and admits
  again, which is the property that would break if coalescing latched.
- Every child id is unique across the whole case, and no two tasks share a
  child id.

A coalescing note that the assertions encode: the service coalesces per run
(`pendingDrain`), so when several drains race, a loser is refused because the
task is already admitted, and the outcome it returns is the winner's. The
invariant that must hold is therefore about **slots and child identity**, not
about which call "won". Asserting per-call ownership would be asserting an
implementation detail that the coalescing contract does not promise.

### C04 — insufficient readiness

**T1. PASS at T1.**

Three ready tasks against `target = 10`. Exactly three real children are
created, and the deficit is reported explicitly as `7` with reason
`insufficient_ready_tasks`, with `desiredTarget` still `10`.

**The hard product rule is asserted against the real registry, not the record:**
exactly three children exist — not ten, and not ten with seven idle. After a
400 ms wait the count is still three, which is the check that no padding exists:
`drain` is "a plain async function with no timer" (`src/host.ts`), so nothing
can appear on its own. Every existing child is one that reached a model request,
so no child exists that is merely resident.

One correction to my own first attempt, recorded because it was a real error in
the test and not in the code: I initially asserted that a drain carrying a new
submission would be *refused* while the ready supply was short. That is wrong.
A drain request **is** a task submission, so admitting it is correct and the
deficit legitimately shrinks from 7 to 6. What the gate actually forbids is
*padding the target with placeholders*, which the test now asserts directly. The
coalescing half is now asserted with three concurrent drains carrying the **same**
submission: exactly one child results, and the losers are refused with
`already admitted`.

### C07 — cancellation not finished

**T1. PASS at T1.**

The interrupt is sent through the real `ctx.subagents.interrupt`, which is
fire-and-return: "the cancel signal is issued before this returns, but the target
may keep running until it observes the signal"
(`packages/subagent/subagent/src/index.ts:318-320`). The adapter holds its model
call and does not observe the abort, so the child is **still `running`** after
the interrupt — exactly the window this gate names.

With the task moved to `cancel_requested`:

- `holdsSlot('cancel_requested') === true` and `holdsSlot('unknown') === true`,
  asserted against `src/states.ts`, the single source of truth for occupancy.
- A premature refill is refused; the slot is genuinely occupied, so there is no
  deficit and the reason is `none`.
- The credit is still reserved: a requested cancel is not a confirmed cancel.
- No overshoot against the real registry: still ten children, and the refused
  task has no child and no record.
- Only after the child really stops (end reason `aborted` — an interrupted turn
  is not evidence the work happened) and the task is confirmed `cancelled` does
  the slot free, admitting exactly one refill. Ten again, never eleven.

The second case covers `unknown`: one task moved to `unknown` keeps the ceiling
intact against a full target, and the run holds its credit.

### C09 — provider limits

**T1. PASS at T1, with one reporting gap stated below.**

Two halves.

**429 through the real wire.** A real `dsh-llm-mock-server` answers `429` with
`Retry-After: 1` (asserted as wire facts). The same failure class then reaches
the production loop for all ten children with the real `llm-retry` executor
mounted, so "bounded backoff" is a behavioural claim rather than a policy object
sitting inertly in a registration. Observed:

- Exactly three attempts per child (initial + `maxRetries: 2`), then a stop.
- **Bounded, asserted by waiting**: after settling, a further 600 ms produces no
  additional attempts. An unbounded retry would keep climbing.
- Each retry is durably recorded as `llm/retry` with `mode: 'normal'`,
  `retry` 1 then 2, `maxRetries: 2`, `delayMs` 5 then 10 (growing), and
  `failure.code: 'RATE_LIMIT'` — the code the real adapter derives from HTTP 429
  (`packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts:102`).
  The paired `llm/retry-started` transitions prove the waits completed rather
  than being abandoned.
- The target stays `10`; the system does not secretly drop to 8.
- **Waiting is not wrapped as execution**: `activeAssignments === 0`,
  `providerWaiting === 0`, `waitingOwnedTool === 0`, while ten slots are held.
- Each child's own Session ends in an error turn carrying `RATE_LIMIT`, rather
  than a green no-op.

**Budget exhaustion.** A run whose child ceiling is 8 against a target of 10
admits exactly eight and refuses two with reason `budget_blocked`.
`desiredTarget` remains `10`, `childCeiling`/`childCommitted` are exactly 8, and
`rootAvailable` is 2. A later submission is refused for the same reason and no
ninth child is created. The system reports "8 of 10 blocked" rather than
rewriting its target as 8.

**REPORTING GAP (a real finding, not a test artefact).** In the sustained-429
case, `deficitReason` is `'none'` and `capacityDeficit` is `0`, because all ten
slots are still held — the target is not unfilled, so there is no deficit to
explain. A reader who consulted only `deficitReason` would see a quiet, healthy,
full wave while **nothing at all is executing** and DSH holds **zero** resident
children. The block is observable, but only through the conjunction of
`activeAssignments: 0` with ten held slots. The deficit vocabulary has no value
for "every held slot belongs to work whose last attempt failed". The test
asserts the observed values so this gap cannot be mistaken for a passing reason.

**Proposed GAPS.md entry, NOT yet written** (this agent does not own
`docs/GAPS.md`, so it is proposed here rather than edited in place — the
coordinator should add it or delegate it):

| ID | Gap | Status | Note |
|---|---|---|---|
| G-SCHED-01 | A run whose every held slot belongs to work whose last provider attempt failed reports `capacityDeficit: 0` / `deficitReason: 'none'`. | OPEN | Measured in `scheduling.test.ts` C09. The target is genuinely unfilled by *executing* work, but the deficit vocabulary is defined against *held slots*, so "blocked by sustained provider failure" has no value. Observable only via `activeAssignments: 0` + ten held slots. Not a correctness bug — nothing is over-admitted and nothing is claimed to be executing — but a reader consulting `deficitReason` alone cannot see the block. |

## Findings about the platform and the seam (not test bugs)

1. **`ctx.subagents.listChildren` is a DURABLE enumeration, not an occupancy
   count.** A child whose activation was disposed still appears, reported as
   `activity: 'inactive'` (`packages/subagent/subagent/src/list-children.ts`,
   cold path through the Session query corpus). Using it as an occupancy
   instrument over-counts: in C03 it reported 13 children where 10 slots were
   held. Occupancy must come from the live registry
   (`ctx.agents.list()` filtered by `parentSession`) or from the run record.
   The suite uses `listedChildren` only for "which distinct children ever
   existed" and `listedRunningChildren` for residency.

2. **A disposed child is removed from the live Session store.** A post-hoc
   `ctx.sessions.get(childId)` returns `undefined` once the activation is gone,
   so any assertion about a finished child's own log made after the fact is
   **vacuous**. The rig therefore captures the `session/event` firehose at event
   time. This is the kind of silent-vacuity trap the project's "no PASS by
   weakening" rule exists to catch, and it was found by a failing assertion, not
   by inspection.

3. **The root is woken by child settlement.** As above: the root takes real
   turns, so "root is idle" and "root issues no requests" are not properties to
   assert. Only "root is not counted among the N" is.

## A rig defect found and fixed during this slice

The teardown originally removed its temp directories after the disposal chain,
not in a `finally`. The early red runs of this file therefore left **32 orphan
directories** in `%TEMP%` — one pair per failing case — because a teardown that
throws (a child that will not settle, a domain that will not close) skipped the
`rmSync` entirely. This is recorded rather than quietly cleaned up, because a rig
that leaks only when it fails makes a failing case hard to tell apart from a
machine that is merely full. The removal now sits in a `finally`, and a run that
fails still cleans up. Verified afterwards: one clean run adds zero directories
(0 before, 0 after).

## Typecheck evidence, and a false pass corrected

`tsconfig.json` **excludes** `src/**/*.test.ts`, so
`tsc -p tsconfig.json --noEmit` exits 0 with or without a test file. That is a
false pass for any "the tests type-check" claim, and it was the reason an
earlier draft of this file carried real type errors invisibly.

Evidence is therefore recorded from `tsconfig.check.json` (identical strict
flags, test exclusion cleared), and:

- `tsc.txt` — the whole-tree run: **exit 2**, with 5 errors. Every one is in a
  file this agent does not own (`control-plane.test.ts`, `research-chain.test.ts`,
  `tool-protocol.test.ts`). This is NOT reported as a pass.
- `tsc-mine.txt` — the same command filtered to `src/scheduling.test.ts`:
  **0 errors**.

`tests.txt` records `exit_code: 0` for the 9-case suite, and was produced with
`--maxWorkers=1 --no-file-parallelism` because several agents share this machine.
The suite was run five times consecutively with the same 9/9 result; no assertion
depends on a timing window that was not observed to hold in all five.

## Not closed here, and not claimed

- **C01/T5** — the live paid N=10 run. `BLOCKED_EXTERNAL`
  (`live_provider_budget_authorized: false`). Unchanged by this slice.
- **A frozen SLO for C02** — no SLO exists in this repository; a measurement is
  recorded instead.
- **C09's deficit vocabulary gap** — recorded above as proposed `G-SCHED-01`.
- The other agents' typecheck errors in `tsc.txt` are theirs to fix; they are
  reported rather than filtered out of the evidence.

## Files this slice owns

- `packages/dsh-daily-work/src/scheduling.test.ts` (created)
- `qualification/results/M9.12-scheduling/` (created)

No production file was edited. `src/host.ts`, `src/record.ts` and
`src/counting.ts` are owned by another agent and were read-only here; the
hashes in `source-digests.txt` pin exactly which revision this result was
measured against, and that revision was re-checked as unchanged after the run.
No production change was needed: every gate closed against the existing
implementation. The only production-side findings are the three seam facts
above, which are documentation and instrumentation concerns rather than
behavioural defects.
