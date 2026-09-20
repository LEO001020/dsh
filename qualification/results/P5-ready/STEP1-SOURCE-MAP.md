# P5 / WORK-READY — STEP 1: SOURCE MAP

Slice: V5 §7 (P0 — make rolling N actually roll) plus §18 oracles WORK-READY,
WORK-ROLLING, WORK-N30, WORK-MULTIROOT.

Worktree: `D:\DSH\work\wt-p5`, branch `wt/p5`, base `2e1b2c2`
(`2e1b2c2d3657407ce7ac621b07b3307d3edd8df4`).

This file is reconnaissance only. It changes no source. Its purpose is to make
the next step an edit rather than a search, because the previous attempt at this
slice burned its whole budget on uncommitted reconnaissance and produced
nothing (round-3 brief §2 rule 4).

Every claim below carries `file:line` and an evidence tag. Tags are round-3
brief §3's vocabulary: `SOURCE_FACT` (read from the tree at this commit),
`PROJECT_FACT` (a measurement this repository already recorded),
`INFERENCE` (mine, not yet measured).

---

## 1. WHERE THE TASK STATE VOCABULARY IS DEFINED

| what | where | tag |
|---|---|---|
| the vocabulary itself, 9 states | `packages/dsh-daily-work/src/states.ts:19-42` (`ADMISSION_STATES`) | SOURCE_FACT |
| `AdmissionState` union type | `packages/dsh-daily-work/src/states.ts:44` | SOURCE_FACT |
| which states hold a slot against N (INV-C1's single source of truth) | `packages/dsh-daily-work/src/states.ts:56-64` (`SLOT_HOLDING_STATES`) | SOURCE_FACT |
| terminal states | `packages/dsh-daily-work/src/states.ts:67-70` (`TERMINAL_STATES`) | SOURCE_FACT |
| the legal transition table | `packages/dsh-daily-work/src/states.ts:81-94` (`TRANSITIONS`) | SOURCE_FACT |
| `assertTransition` — throws `TransitionError` on an illegal edge | `packages/dsh-daily-work/src/states.ts:114-116` | SOURCE_FACT |
| the per-task record whose `state` is this vocabulary | `packages/dsh-daily-work/src/record.ts:54-77` (`taskRecordSchema`); the field is `state: z.enum(ADMISSION_STATES)` at `record.ts:62` | SOURCE_FACT |
| the slot-holding derivation actually used by admission and by counts | `packages/dsh-daily-work/src/counting.ts:134-140` (`heldSlots`) | SOURCE_FACT |
| the run aggregate that holds `tasks` | `packages/dsh-daily-work/src/record.ts:406-506` (`runRecordSchema`); `tasks: z.record(z.string(), taskRecordSchema)` at `record.ts:499` | SOURCE_FACT |
| the domain/table that persists it | `packages/dsh-daily-work/src/host.ts:102-111` (`workDomainSpec`, table `runs`, `domainTable<string, RunRecord>(runRecordSchema)`) | SOURCE_FACT |
| the schema version, and the rule that a shape change needs a cutover | `packages/dsh-daily-work/src/host.ts:89` (`WORK_SCHEMA_VERSION = 1`) | SOURCE_FACT |

### 1.1 The four positions that matter for READY

`states.ts:9-17` names five positions the delivery plan requires be kept
separate; the first is **"task intent durably admitted -> `prepared`"**.
There is currently **no state that means "decided, durable, but consuming
nothing"**. `prepared` is already a slot-holding state
(`states.ts:56-64`), so reusing it for READY would silently consume a slot —
which V5 §7.1 explicitly forbids ("READY consumes: no child slot, no committed
child budget reservation"). This is the central design constraint of the slice.

`INFERENCE`: a new state is required rather than a reuse. The two candidates are
(a) a new member of `ADMISSION_STATES` excluded from `SLOT_HOLDING_STATES`, or
(b) a separate durable table in the same run aggregate (`workDomainSpec.tables`,
`host.ts:108-110`). V5 §7.1 allows either ("Add a task state `ready` **or an
equivalent durable assignment table inside the same run aggregate**"). (a) is
the smaller change and keeps one vocabulary, but it puts a non-admission state
into a type named `AdmissionState` and into `assertTransition`'s table; (b)
keeps admission and intent separate at the cost of a second table and a second
schema. This choice is deferred to step 2 and will be recorded there.

---

## 2. WHERE `work submit` CURRENTLY ENTERS

Two entry points exist, and they are different seams:

| entry | where | what it does today | tag |
|---|---|---|---|
| the MODEL-FACING TOOL, `work` action `submit` | `packages/dsh-daily-work/src/tools.ts:156-176` | resolves the run (`tools.ts:130-133`), then **calls `service.drain(runId, [one request], exec.signal)` immediately** at `tools.ts:162-166` | SOURCE_FACT |
| the HUMAN COMMAND `/work` | `packages/dsh-daily-work/src/command-work.ts:106-139` (parser), `:196-319` (handler) | has verbs `status`/`start`/`target`/`stop` only (`command-work.ts:57-63`). **It has no submit verb.** | SOURCE_FACT |

The request the tool builds is
`{ taskId, childId: args.childId ?? \`child-${taskId}\`, prompt: goal, reservedCost: 1 }`
(`tools.ts:161-165`). Note `reservedCost: 1` is hardcoded there and
`allowedCapabilities` is not supplied by the tool at all — `runDrainPass` fills
`['reader']` (`host.ts:2262`).

**This is gap #2 of the dispatch, confirmed by reading, not inferred.**
`drain` → `tryReserveAdmission` → a refusal is returned as a value
(`host.ts:2256-2269`), and the refusal path **writes nothing** — that property is
stated as deliberate at `host.ts:1308-1314` ("A REFUSAL WRITES NOTHING... a
refused attempt consumes no slot, no credit and no generation"). The
consequence for the model is that the submitted `goal` string is **not
anywhere durable** when the run is full: it existed only in the tool-call
argument. The model must re-derive it to try again.

`PROJECT_FACT` corroboration: `tools.ts:174` reads `record?.tasks[taskId]` to
report `taskState`, so on a refusal the tool reports `accepted: false` with a
`reason` and **no `taskState`** — the caller learns only "no".

### 2.1 Who calls `drain` in production

`grep -rn "\.drain(" packages/dsh-daily-work/src/*.ts` excluding tests returns
exactly **one** `WorkService.drain` caller: `tools.ts:162`. (The other hits are
unrelated `drain` methods: `kernel-lifecycle.ts:1492/1497/1576/1710/1894` and
`programmatic-scope.ts:944/953`.) `SOURCE_FACT`.

---

## 3. WHERE A READY STATE WOULD HAVE TO BE PERSISTED TO BE DURABLE

The durability mechanism already exists; READY must go through it, not beside
it.

| what | where | tag |
|---|---|---|
| the table handle | `packages/dsh-daily-work/src/host.ts:659-663` (`private runs()`) | SOURCE_FACT |
| read one run | `host.ts:1050-1054` (`getRun`) | SOURCE_FACT |
| the **single write path for a non-admission mutation** | `host.ts:2341-2344` (`private async mutate(runId, fn)` → `this.runs().update`) | SOURCE_FACT |
| the **atomic admission write** — the one V5 §21 says to KEEP | `host.ts:1322-1657` (`tryReserveAdmission`), whose whole decision is inside ONE `this.runs().update` opened at `host.ts:1399` | SOURCE_FACT |
| the storage-domain write chain that serializes those updates | `host.ts:2036-2045` documents it, citing `storage-domain/src/domain.ts:83-89` | SOURCE_FACT |
| proof the chain is the authority and the in-memory leader is not | `host.ts:2027-2034`; the test that drives the path "WITH THE COALESCER DEFEATED" is `f5-admission.test.ts` | PROJECT_FACT |
| the post-reservation state walk that a READY record must be removed by | `host.ts:2270-2308` (`prepared` → `launching` → launch → `accepted` / `unknown`) | SOURCE_FACT |
| the only method that can write a task's terminal state, and its budget effect | `host.ts:1659-1786` (`transition`), release rule at `host.ts:1676-1677` | SOURCE_FACT |

**Where READY must be written, stated precisely.** A READY insert/update is a
write to the run aggregate, so it must be a `this.runs().update(...)` — either
the existing `mutate` (`host.ts:2341`) or, if the insert must be atomic with a
duplicate-conflict decision, its own `update` mirroring
`tryReserveAdmission`'s single-update shape. It must **not** be a second
in-memory map: `readyTaskCount` (`host.ts:403`) is process-local, is fed only by
`setReadyTasks` (`host.ts:1062-1064`), and `SOURCE_FACT`: that setter's only
callers are in tests — so today `counts.readyTasks` is a number nothing
durable produces, and `explainDeficit` reads it at `counting.ts:287` to return
`'insufficient_ready_tasks'`.

`INFERENCE`: making READY durable will make that existing deficit vocabulary
real for the first time, and `setReadyTasks` becomes either the projection of
the durable table or a removable vestige. This is worth checking in step 2 —
`counting.ts:39` declares the field and `tools.ts:105/141` surfaces it to the
model.

### 3.1 Restart/boot surface for §7.5

| what | where | tag |
|---|---|---|
| boot opens the domain and nothing else — **no run enumeration, no reconciliation, no drain** | `packages/dsh-daily-work/src/host.ts:594-611` (`open()`) | SOURCE_FACT |
| the plugin's `apply` awaits `open()` and installs the target setting | `packages/dsh-daily-work/src/host-plugin.ts:39-55` | SOURCE_FACT |
| run enumeration already exists | `host.ts:1126-1128` (`listRunIds`) | SOURCE_FACT |
| the phases a boot must classify | `packages/dsh-daily-work/src/record.ts:390-394` (`RUN_PHASES` = open/paused/closing/closed) | SOURCE_FACT |
| `pause` / `resume` / `beginClosing` | `host.ts:1158-1175`, `:1177-1206`, `:1140-1156` | SOURCE_FACT |
| the project's standing constraint against auto-replay | dispatch + V5 §7.5; the code's own expression of it is `unknown` being explicitly "deliberately NOT an error state that auto-retries" (`states.ts:36-41`) and `host.ts:2296-2303` (`releaseReservation: false` on a failed launch) | SOURCE_FACT |

**Where the boot hook goes**: inside `open()` after the domain is open
(`host.ts:603-610`), or in `host-plugin.ts:54` between `open()` and the end of
`apply`. `INFERENCE`: `open()` is the better site because `host.test.ts`
constructs the service directly and calls `open()`, so the behaviour would be
exercised by the existing service-level rigs rather than only through the
plugin.

---

## 4. WHERE A COMPLETION EVENT WOULD HAVE TO BE OBSERVED

### 4.1 The event exists and is real

| what | where | tag |
|---|---|---|
| `subagent/end` is declared on `Context['events']` with `@mode emit` | `packages/dsh-daily-work/node_modules/@deepseek-ai/dsh-subagent/src/index.ts:172` (declaration block `:135-173`) | SOURCE_FACT |
| its payload type | `.../dsh-subagent/src/types.ts:100-116` (`SubagentRunEndInfo`): `runId`, `provider`, `id: SessionId`, `local`, `stopReason`, `lastAssistantMessage?` | SOURCE_FACT |
| the three emit sites, all in the run's own terminal reaction | `.../dsh-subagent/src/lifecycle.ts:150`, `:158`, `:212` | SOURCE_FACT |
| the identity invariant tying it to `subagent/start` | `.../dsh-subagent/src/invariant.ts:56-79` | SOURCE_FACT |

`SOURCE_FACT`: `info.id` is **the child's `SessionId`** — the same value the
launch port reserved and asserted
(`packages/dsh-daily-work/src/launch-port.ts:78` passes `SessionId(request.childId)`;
`:92-97` refuses a provider-minted id that differs). So the map from event to
work task is `childId === String(info.id)`, and it is exact rather than
heuristic.

### 4.2 The listener does NOT exist in production — gap #1, re-verified

`SOURCE_FACT`, re-run on this worktree:

```
grep -rn "subagent/end" packages/dsh-daily-work/src/*.ts | grep -v ".test.ts"   -> no output
grep -rn "subagent/end" --include=*.ts packages/ | grep -v node_modules | grep -v "\.test\.ts"  -> no output
```

The only occurrences in the repository are three test files:
`cap10-storm.test.ts:226`, `lifecycle.test.ts:101`, `scheduling.test.ts:238` —
all `ctx.on('subagent/end', ...)` **observers that push into a local array**,
none of which is a production listener.

`PROJECT_FACT` corroboration, from S9's own record
(`qualification/results/S9-cap10/FINDINGS.md:186-193`, §4 "THE RESIDUAL, STATED
PLAINLY"): *"Nothing in this package re-triggers a drain when a child settles.
There is no `subagent/end` listener, and no non-test writer of `settling` or
`confirmed` exists anywhere in the tree... So the top-up trigger is the ROOT
ASKING... It is NOT satisfied in the stronger sense of 'a completion
automatically produces a replacement with no further call', and this slice does
not claim that."* And `cap10-storm.test.ts:77-79` repeats it inside the test
file that would otherwise be mistaken for the proof.

### 4.3 The consequence, in state terms

`SOURCE_FACT`: no production code writes `settling`, `confirmed` or `cancelled`
into a task. `transition` (`host.ts:1659`) is the only writer, and every
production call site of it — `host.ts:2270` (`launching`), `:2287-2293`
(`unknown`, no port), `:2300-2306` (`unknown`, launch failed), `:2308`
(`accepted`) — targets a non-terminal state. So a task that reaches `accepted`
stays `accepted` forever, keeps holding its slot
(`states.ts:56-64` includes `accepted`), and the run's occupancy never falls.
`INFERENCE`, and it is the mechanism behind V5 §7.4's instruction: the
completion listener is not an optimization, it is the **only** thing that can
ever move occupancy down.

### 4.4 Where the listener must be mounted

`mountChildAdmissionGuard` (`packages/dsh-daily-work/src/capacity.ts:591-625`)
is the existing precedent: it registers `ctx.on('agent/created', ...)`
(`capacity.ts:593`) and `ctx.on('agent/disposed', ...)` (`capacity.ts:617`) from
the `WorkService` constructor (`host.ts:439-451`), and `capacity.ts:586-587`
states the ownership rule — listeners registered through `ctx.on` are owned by
that fiber and removed with it.

`SOURCE_FACT`: `agent/disposed` already releases the HOST-WIDE gate slot
(`capacity.ts:618`), which is a different ledger from the per-run task state.
The two must not be conflated: the gate slot is released on dispose, but the
**run's** task state and its reserved credit are not touched by anything.

`INFERENCE`: the natural site for the completion listener is the same
constructor, beside the guard mount, or a new `mountCompletionObserver(ctx, {
service })` in the file that ends up owning the reconcile logic — with the
`capacity.ts` region left alone so P6/P7's work does not contend. `capacity.ts`
is in my owned set but I will not need to edit it.

---

## 5. WHAT ALREADY EXISTS THAT §7 CAN BUILD ON (so step 2 adds no new architecture)

V5 §0: "stop adding architecture... every P0 connects a mechanism that already
exists." Measured inventory:

| mechanism §7 needs | already exists at | gap |
|---|---|---|
| atomic admission, target/cap/budget in one write | `host.ts:1322-1657` (`tryReserveAdmission`) | none — keep (V5 §21) |
| one drain leader per run, generation/dirty loop | `host.ts:2053-2088` (`drain`), `:2090-2152` (`runDrainLeader`) | none for efficiency; it is explicitly not the correctness layer (`host.ts:2027-2034`) |
| the pass that walks a batch and launches | `host.ts:2154-2313` (`runDrainPass`) | it walks **queued caller requests**, not a durable ready set |
| a durable per-task record with state, cost, capabilities, createdAt | `record.ts:54-77` | `state` has no READY member; no submission sequence |
| a durable run aggregate + serialized writes | `host.ts:102-111`, `:2341-2344` | none |
| a typed refusal vocabulary for a deficit | `counting.ts:96-101` (`DeficitReason`), incl. `'insufficient_ready_tasks'` at `:101`, returned at `:287` | the input it reads (`readyTasks`) is not durable — see §3 |
| host-wide cap 30, cross-root, one ledger per host | `capacity.ts` `ChildAdmissionGate`; mounted at `host.ts:439-451`; `HARD_CHILD_CAPACITY` imported by `command-work.ts:46` | none for §7.6's multiroot arm |
| a real child-settled event | `subagent/end`, §4.1 | no production listener |
| an observation channel for "started real work" | `host.ts:1067-1078` (`observe`), consumed by `countRun` (`counting.ts:172-178`) | process-local; not a substitute for completion |

**The one thing §7 must add that has no precursor** is the durable READY
assignment itself. Everything else on the list is a connection.

---

## 6. THE TWO CONFIRMED GAPS, RESTATED WITH THIS STEP'S EVIDENCE

**Gap 1 — no completion-driven refill.** `SOURCE_FACT` §4.2 (no production
`subagent/end` listener; three test-only observers). `PROJECT_FACT` §4.2 (S9's
own §4 residual). `INFERENCE` §4.3 (nothing can move a task out of a
slot-holding state, so occupancy is monotone non-decreasing in production).
Verdict: **what exists is "refill when called", not "sustain N".** Confirmed.

**Gap 2 — `work submit` is not durable.** `SOURCE_FACT` §2 (`tools.ts:162-166`
calls `drain` immediately; the refusal path writes nothing, by design,
`host.ts:1308-1314`; the tool then reports only `accepted: false` + `reason`,
`tools.ts:169-175`). The `goal` string is not persisted on refusal. Verdict:
**an assignment the model already decided is lost when the run is full.**
Confirmed.

---

## 7. UNKNOWNS THIS STEP DID NOT RESOLVE (carried into step 2)

1. Whether a READY member of `ADMISSION_STATES` or a second table is the
   smaller honest change. Both are permitted by V5 §7.1. `UNKNOWN`.
2. Whether `readyTaskCount` / `setReadyTasks` (`host.ts:403`, `:1062`) becomes
   the durable projection or is deleted. Its only non-test callers are tests.
   `SOURCE_FACT` for the caller set; the disposition is `UNKNOWN`.
3. Which production surface calls `requestDrain` besides the new listener and
   `work submit`. V5 §7.3's pseudo-code implies `submit` and the completion
   event; nothing else is specified. `UNKNOWN`.
4. The exact quiescence test §7.4 requires ("release the slot only when
   quiescence is established"). The available signals are
   `subagent/end.stopReason` (`types.ts:107`) and `agent/disposed`
   (`capacity.ts:617`); whether both are needed is `UNKNOWN` and will be
   measured, not assumed.
5. Whether the N=30 rolling arm can run at all on this machine without
   contending with the other 14 writers. V5 §21 makes N=30 a **product
   contract, not a performance claim** (dispatch, and V5 §7.6's list). It will
   be measured through the service with the real registry, and any arm that
   cannot run honestly will be reported as NOT_RUN with the reason rather than
   faked.

---

## 8. FILES THIS STEP READ, AND WHAT IT DID NOT TOUCH

Read: `packages/dsh-daily-work/src/{host.ts,states.ts,record.ts,counting.ts,capacity.ts,command-work.ts,tools.ts,host-plugin.ts,launch-port.ts,cap10-storm.test.ts}`,
`docs/GAPS.md`, `qualification/results/S9-cap10/FINDINGS.md`,
`qualification/results/V8-capacity/GATES.md`,
`docs/decisions/AUDIT-REQUEST-acceptance-results.md`,
`docs/exec-plans/v5-round3-brief.md` (from `integrate-test`, not present on this
base), and V5 §7 / §18.

Written: this file. **No source file was modified in step 1**, so nothing in the
tree can have regressed as a result of it.
