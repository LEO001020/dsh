# R9 — production topology for the recovery-epoch question (F8 / REC-09 / REC-10)

**Slice:** decide the recovery-epoch question from the ACTUAL production topology.
**Measured at:** `a4b0838` (the shared brief), worktree `D:\DSH\work\wt-r9`, branch `wt/r9`.
**Source digests at measurement** (`head-at-measurement.txt`):

| file | sha256 |
|---|---|
| `packages/dsh-daily-work/src/recovery.ts` | `5edde8a5d8d79b0a138f06818a9deb3a04ccc6c22dd7bfe1ae338c967a45f440` |
| `packages/dsh-daily-work/src/record.ts` | `e481105052dfbc0c9d1d341ded03dc6941d06e087f0d15a5e818876c0ce62867` |
| `packages/dsh-daily-work/src/host.ts` | `c3b1bb7e00d67b44b47626fd9fb8d283a7a387557d809ac531c39904312f8dbd` |

> **LINE-NUMBER PROVENANCE — which tree do the `file:line` citations point at?**
> Every line number in this document refers to the **POST-CHANGE tree** (this
> branch's working tree after the deletion), *not* to `a4b0838`. The digests above
> are of the **PRE-CHANGE** files, recorded before any edit. **The two are not
> interchangeable**, and the offset is not uniform across files:
>
> | Site | at `a4b0838` | in this tree | delta |
> |---|---|---|---|
> | `host.ts` — `admit` slot refusal | `:817` | **`:824`** | +7 |
> | `host.ts` — `unknown` (no port) | `:1335` | **`:1342`** | +7 |
> | `host.ts` — `unknown` (launch failed) | `:1357` | **`:1364`** | +7 |
> | `host.ts` — `accepted` | `:1372` | **`:1379`** | +7 |
> | `recovery.ts` — the `to:` union annotation | `:207` | **gone** (deleted) | — |
>
> `host.ts` shifts by exactly +7 because this slice added 13 and removed 6 comment
> lines before `admit`. Root independently cited `host.ts:816-817` and
> `recovery.ts:207`; **both were correct for `a4b0838` and neither resolves in this
> tree** — root was measuring the base, I was measuring the change. This table is
> here so a third reader does not have to rediscover which is which. When checking a
> claim below, **use the post-change numbers**; to check the pre-change ones, read
> `git show a4b0838:<path>`.

**DECISION: DELETE.** Stale-generation settlement **cannot occur** in this topology,
because no settlement path exists at all. The epoch guard protects a path that is
not merely unreachable but **absent**, so fencing it would mean inventing the
settlement producer — the one thing V3 §N and audit F8 forbid.

> **FALSIFICATION RECORD — read this before trusting any sentence in this file.**
> The first version of this document rested the decision on *"no production call
> site targets a terminal state; the only call sites that ever did are `recovery.ts`
> and the unreachable CLI."* **Root falsified that**: `host.ts:1342` and `host.ts:1364`
> write the state `unknown` on the drain path, reachable from the model-facing `work`
> tool via `tools.ts:162`. The supporting prose overclaimed from "no *terminal*
> write" to "the product never reaches a terminal state, so a settlement has no
> producer".
>
> **The defect was in the instrument, not only the prose.** The test I built to check
> the claim used a hand-picked state list
> (`settling|confirmed|cancelled|executing|cancel_requested`) that **omitted
> `unknown`** — so the oracle was constructed to confirm the claim it was meant to
> test. That is this project's own recorded defect class (`G-FIX-04`: an oracle
> weaker than its scenario passes while the product is broken).
>
> **Corrected in this revision:** §1.5 (rewritten with FACT 1 and FACT 2), §1.8
> reason 3, §2, §3.1 (new lift-ready sentence), the source comments in `recovery.ts`,
> `record.ts` and `sec-gates.test.ts`, and the two test regexes — which now derive
> the terminal set from `TERMINAL_STATES` instead of hand-picking it, and assert the
> `unknown` write explicitly rather than filtering it out. The decision itself is
> unchanged, and the corrected fact is **stronger**: the product writes an in-flight
> state it has no path to leave (§1.5 FACT 2, measured through the real drain).
> Raw observation preserved, explanation retracted — per the brief's §9 rule.

---

## 1. The caller graph, edge by edge

Every edge below is a call or an import, cited by `file:line`. Read it top to bottom;
the decision follows from the last three rows.

### 1.1 Who reserves a task

| Step | Site | Evidence |
|---|---|---|
| Model asks for work | `work` tool, `submit` action | `packages/dsh-daily-work/src/tools.ts:156-166` |
| Tool calls the drain | `service.drain(runId, [{taskId, childId, prompt, reservedCost: 1}], exec.signal)` | `packages/dsh-daily-work/src/tools.ts:162-166` |
| Drain admits atomically | `await this.admit({runId, taskId, childId, assignmentDigest, reservedCost, allowedCapabilities: ['reader']})` | `packages/dsh-daily-work/src/host.ts:1305-1312` |
| Admit writes `prepared` + reservation + slot, in ONE domain `update` | `state: 'prepared'` inside `this.runs().update(...)` | `packages/dsh-daily-work/src/host.ts:773-863`, write at `host.ts:827` |

**Reservation owner:** `WorkService`, one instance, mounted once by the host profile
(`packages/dsh-daily-work/src/host-plugin.ts:41-53`).

### 1.2 Who launches the continuable child

| Step | Site | Evidence |
|---|---|---|
| Drain moves `prepared -> launching` | `await this.transition({runId, taskId, to: 'launching'})` | `packages/dsh-daily-work/src/host.ts:1323` |
| Drain launches outside the record lock | `await port.launch(request, signal)` | `packages/dsh-daily-work/src/host.ts:1349` |
| Port is the production continuable port | `createContinuableLaunchPort({subagents, parent: root, provider, maxDepth})` | `packages/dsh-daily-work/src/host.ts:393-401`; installed at `host.ts:518` from `createRun` |
| The only file that touches `ctx.subagents` | `await deps.subagents.startContinuable(spec)` | `packages/dsh-daily-work/src/launch-port.ts:88` |
| Admission edge recorded | `await this.transition({runId, taskId, to: 'accepted'})` | `packages/dsh-daily-work/src/host.ts:1372` |

**The port resolves at ADMISSION, never at completion** — `launch-port.ts:9-20`
quoting the pinned DSH contract (`packages/subagent/subagent/src/index.ts:254-261`).
Nothing in this package is called back when the child finishes.

### 1.3 Who owns the child activation

| Fact | Site |
|---|---|
| DSH owns it, keyed by the parent Agent **object** | `packages/subagent/subagent/src/continuation-activation.ts:180` — `private readonly rootPools = new WeakMap<Agent, ActivationPool>()` |
| This package holds only the process-local capacity gate, updated on `agent/created` / `agent/disposed` | `packages/dsh-daily-work/src/capacity.ts:593-619` |

Those two listeners touch **only** the capacity ledger (`gate.reserveChild` /
`gate.releaseChild`). Neither writes task state. They are the only `ctx.on`
registrations in the whole package's non-test source (grep: `capacity.ts:593`,
`capacity.ts:617`; all other `.on(` hits are Node stream/child-stdout handlers in
`durability-runner.ts`, `web-provenance.ts`).

### 1.4 Who reports completion

**Nobody, in this package.** There is no completion listener, no inbox callback, no
result route, and no outbound notification consumer:

- `outbox` is written (`host.ts:693-702`, `host.ts:839-847`, `host.ts:1172-1180`) and
  **never read** by any non-test source outside `record.ts`'s schema.
- `recordSpend` / `spendRoot` / `retainUnknown` / `resolveHalt` are declared
  (`host.ts:1012`, `1068`, `1123`, `1157`) and have **zero non-test callers**.
- `observe(runId, liveness)` (`host.ts:597`) has **zero non-test callers** (the
  `no-sandbox-contract.ts:564,609` hits are a different `observe` on another class).
- `reconcile.ts` computes a `next` state (`reconcile.ts:95,108,121,134,144,159,168,194`)
  and **no production module applies it**; its only non-test importer is the
  hand-run CLI `durability-runner.ts:29`, itself in no production import graph
  (`qualification/results/V6-recovery/import-graph-v6.txt:85-88`).

### 1.5 What exact method mutates WorkService state, and which states it writes

**`WorkService.transition`** (`packages/dsh-daily-work/src/host.ts:891-948`).

It is the only writer of `TaskRecord.state` (`host.ts:926`), and it owns the three
facts that make a settlement authoritative: the state, the reservation release
(`host.ts:907-922`) and the tombstone (`host.ts:931-934`). All three move inside one
`this.runs().update(...)` (`host.ts:902-943`) — so the atomicity the fencing
requirement asks for **already exists**; what is missing is a caller.

> **CORRECTION (this section was falsified and is rewritten).** An earlier revision
> said *"no production call site targets a terminal state; the product never
> performs a terminal-state write at all"* and supported it with a hand-picked
> state list that **omitted `unknown`**. Root falsified that: `host.ts:1342` and
> `host.ts:1364` DO write `unknown` on a production path. The corrected facts are
> the two below, and the deletion rests on the second, which is *stronger* than the
> sentence it replaces.

**FACT 1 — no production call site targets a TERMINAL state.** Terminal is defined
by the project as `confirmed | cancelled` (`states.ts:67-70`). Every non-test call
site of `transition`, with its target:

| Site | Target | Terminal? | Reachable from the product? |
|---|---|---|---|
| `host.ts:1330` | `launching` | no | yes (`runDrain`) |
| `host.ts:1342` | **`unknown`** (no launch port installed) | no | **yes (`runDrain`)** |
| `host.ts:1364` | **`unknown`** (launch failed) | no | **yes (`runDrain`)** |
| `host.ts:1379` | `accepted` | no | yes (`runDrain`) |
| `recovery.ts:145` | `launching` | no | no — module has no non-test importer |
| `recovery.ts:170` | `unknown` | no | no — same |
| `recovery.ts:184` | `accepted` | no | no — same |
| `durability-runner.ts:84,86,87,89,90,91` | `launching`, `accepted`, `executing` | no | no — hand-run CLI, zero importers |

**No row targets `settling`, `confirmed`, `cancelled` or `cancel_requested`.** The
only non-test file that names any of them at all is `durability-runner.ts`
(`executing`, which is not terminal), and it is unreachable. Verified by exhaustive
`to: '<state>'` grep over `src/*.ts` excluding `*.test.ts`, and by a test that
derives the terminal set from `TERMINAL_STATES` rather than hand-picking it.

**FACT 2 — the state the product DOES leave a task in has no exit.** The drain's
two failure arms write `unknown` with `releaseReservation: false`, so the task
holds its slot (`states.ts:63`; `unknown` is in `SLOT_HOLDING_STATES`). The state
machine permits six exits from `unknown` — `accepted | executing | settling |
confirmed | cancelled | cancel_requested` (`states.ts:93`) — and:

- `settling`, `confirmed`, `cancelled`, `cancel_requested` have **no non-test
  writer anywhere** (FACT 1);
- `executing` has exactly one non-test writer, `durability-runner.ts:91`, and that
  file is the hand-run CLI with **zero importers** — so it is not a production path;
- `accepted` has exactly one production writer, `host.ts:1379`, and it is
  **unreachable for an `unknown` task**: `admit` refuses a task that still holds
  its slot — `dailyWork: task "..." is already admitted as unknown`
  (`host.ts:823-825`) — and `relaunchPrepared` refuses anything that is not
  `prepared` (`recovery.ts:103-116`).

So no exit from `unknown` is reachable in the product, by either route: no writer
exists, or the writer exists but cannot be reached for a task in this state.

**Measured, not inferred** (test "and nothing can move a task OUT of `unknown`"): a
task driven to `unknown` by a failing launch stays `unknown` with its reservation
held through (a) a re-drain of the same task and (b) a `relaunchPrepared` attempt.

**Why this is the decisive fact.** A settlement is the act of **leaving** an
in-flight state. The product writes one in-flight state it cannot leave, and no
production path performs a terminal write in any generation. So a settlement —
stale or current — has no producer to deliver it.

### 1.5.1 The `unknown` state's fate: recorded limitation, and reported defect

This is **adjacent to this slice and not this slice's to fix**, but it must not be
lost, so it is stated both ways:

- **As a limitation of v2:** the product can enter `unknown` and has no path out of
  it. The slot and its reservation are held indefinitely, `capacityDeficit` accounts
  for it (`counting.ts:127-128` buckets it as `quarantinedUnknown`), and the
  mechanism *named* for resolving it — `reconcile.ts`'s `reconcileRun` — has no
  production caller either (only `durability-runner.ts:216`, the unreachable CLI;
  its decisions are computed and reported, never applied).
- **As a defect worth a GAPS row:** *"the product can enter a state it has no path
  to leave"* — a task left `unknown` holds a child slot forever with no production
  resolution, so N is permanently reduced by each failed launch. The state machine
  documents `unknown` as a resting state *"until a reconciliation resolves it"*
  (`states.ts:37-39`), and no reachable reconciliation exists. **Root should file
  this**; I did not fix it, because inventing a caller is exactly what this slice
  forbids, and choosing the real resolution path is a separate design decision.


### 1.6 Which process owns each step

**One process.** Every step above runs in the host process:

- the service is mounted once at host level (`host-plugin.ts:41-53`,
  `cordis.patch.yml` DIFFERENCE 2);
- the tool runs in the same host (`tools.ts`, mounted in the agent preset);
- the launch port calls the **in-process** subagent runtime
  (`launch-port.ts:88` → `SubagentRuntime.startContinuable`);
- there is **no** IPC/queue/socket/HTTP settlement surface in non-test source:
  no `worker_threads`, no `child_process` (except the hand-run CLI
  `durability-runner.ts:23,124`), no `net.createServer`, no `WebSocket`,
  no `postMessage`/`MessageChannel`. The only `ctx.subprocess.spawn` uses are
  `verify.ts:819,1087` and `worktree-isolation.ts:367`, neither of which is a
  settlement channel.

### 1.7 What survives a Host restart

Only the durable run record, in domain `dsh_daily_work` (`host.ts:59,81-91`).

Process-local and therefore **gone** on restart (`host.ts:223-234`):
`launchPort`, `liveness`, `readyTaskCount`, `pendingDrain`, and the capacity gate
`this.gate` (`host.ts:260`).

The re-adopting generation re-reads the same record; `resume` re-opens the phase
only (`host.ts:707-713`). **Nothing bumps the epoch** — measured by a real SIGKILL
plus a real re-adoption (archived: `BEFORE-durability-advanced-T9A.txt`, test
"a REAL SIGKILL and a real re-adoption do NOT bump the epoch", passing at the
pre-change tree). `pause` (`host.ts:688`), `resume` (`host.ts:707`),
`beginClosing` (`host.ts:670`) and `setTargetChildren` (`host.ts:738`) are the only
phase/record mutators reachable from the product, and none of them writes `epoch`.

### 1.8 Can an old actor deliver a settlement after a newer generation is authoritative?

**No.** Three independent reasons, each sufficient:

1. **There is no settlement entry point.** The only function that could receive one
   was `applyWorkerSettlement` (deleted; it was `recovery.ts:254`). Repo-wide grep
   over `*.ts`, `*.js`, `*.mjs`, `*.json` (excluding `node_modules`, `lib/`) found
   callers **only** in test files. `recovery.ts` has no non-test importer
   (`import-graph-v6.txt:89-92`; re-derived in-tree by
   `durability-advanced.test.ts`).
2. **No actor produces a settlement.** A settlement would have to come from the
   child or from a host-side completion listener. The child has no channel into this
   package (1.6), and no completion listener exists (1.4). The `epoch` field was
   written in exactly one place — `initialRunRecord`, to the literal `1` — so even a
   wired guard would have compared `1 !== 1` forever.
3. **The product never performs the write a settlement would perform.** A settlement
   is the act of *leaving* an in-flight state. No production call site targets a
   terminal state, and the one in-flight state the product does write — `unknown`,
   with the reservation held — has **no production exit at all** (1.5, FACT 2,
   measured through the real drain). So there is no state for a settlement to
   resolve, in any generation, stale or current.

A stale settlement is therefore **not physically possible**: it requires a
settlement producer that does not exist. Implementing fencing would mean
**manufacturing that producer**, which is precisely what the audit forbids
("Do not create a cross-process worker solely to make REC-09/REC-10 pass").

> **Note on how this argument was corrected.** Reasons 1 and 2 were unchanged. An
> earlier revision's reason 3 said *"the product never reaches a terminal state"* —
> true as written about terminal states, but it was supported by a hand-picked state
> list that omitted `unknown`, and the surrounding prose overclaimed it into "the
> product never performs a terminal-state write". Root falsified that reading, and
> the corrected reason 3 is stronger: it names the state the product *does* write and
> shows that state has no exit.

---

## 2. What was deleted, and what that does and does not mean

**This removes a claim that was never true. It does not remove a working mechanism
that the product relied on** — the distinction V3 §N and `G-SEAM-50` require.

Deleted from `recovery.ts`: `WorkerSettlement`, `SettlementOutcome`,
`applyWorkerSettlement`, `REFUSAL_DOMAIN_NAME`, `refusalRecordSchema`,
`RefusalRecord`, `refusalDomainSpec`, `RefusalLedger`.

Deleted from `record.ts`: the `epoch` field from `runRecordSchema` and from
`initialRunRecord`.

Corrected claims (comment-only): `host.ts` module header (`host.ts:19-21`) and
`createRun`'s doc (`host.ts:490-492`) both claimed a per-await run-epoch re-check
that no expression in the file performs.

Kept: `relaunchPrepared` (`recovery.ts:88`), which is **a different claim** (gate
D03: relaunch a proven-unlaunched task exactly once under its original reserved
childId). It is equally unreachable — `recovery.ts` has no non-test importer — but
it is not the epoch question, and deleting it is a separate slice decision. Recorded
here as adjacent evidence rather than changed silently (brief §9).

### 2.1 Why the guard was never reachable, in one line

`recovery.ts` is in **no** package entry point's transitive closure
(`import-graph-v6.txt:68-92`, 26 reachable / 6 unreachable of 32 non-test modules;
re-derived in-tree with `host.ts` as the positive control at
`durability-advanced.test.ts:947-955`).

### 2.2 The `epoch` field had no real consumer — REMOVED

V3 §N says *"remove the unused epoch field if no real consumer requires it."* It
was removed, from both `runRecordSchema` and `initialRunRecord`, and the reason is
that no real consumer existed: repo-wide, outside `recovery.ts` (now deleted) and
`record.ts` (declaration + initialiser), the field was referenced only by **test**
files — `durability-records.test.ts`, `durability-advanced.test.ts`,
`sec-gates.test.ts`, `tool-protocol.test.ts`, `isolation.test.ts`,
`upg-gates.test.ts`. No production module ever read it.

Read-compatibility was **probed, not assumed** (`readcompat-probe.mjs` /
`readcompat-probe.txt`): a store written with the legacy key, then opened by the
post-change schema, opens cleanly and the extra key is dropped. Stated limitation:
the removal is **one-way** — a pre-change build reading a post-change record would
reject it, because the old schema required the field.

### 2.3 This removes a claim that was never true, not a working mechanism

`G-SEAM-50` records that `CMP-06`'s protection of the sandbox policy is
**unreachability, not immutability** — a value that looks frozen only because no
caller exists. This slice is the same shape, one module over: an **epoch that looks
like a guard only because nothing checks it**. The deletion removes a claim, not a
control. No product behaviour changes, because no product path reached the deleted
code or read the deleted field: the composed daily profile boots identically
(`product-probe.txt`), and the run record simply no longer carries a field nothing
consumed.

---

## 3. v1 history is preserved, and how v2 states the non-claim

`REC-09` and `REC-10` stay **FAIL** in
`qualification/specs/acceptance-spec.trusted-local-v1.json` — the FAIL is preserved,
not resolved, and this is asserted by a test so it cannot be quietly improved
(`durability-advanced.test.ts`, "the v1 FAIL is preserved"). Nothing in this slice
edits v1, `qualification/gates.json` or `compatibility.lock.json`.

### 3.1 Wording for R0 — how v2 expresses "deliberately not claimed"

R0's oracle requires ARM B to **name the topology fact that makes stale settlement
physically impossible**, and states that `NOT_CLAIMED` carries the same burden of
proof as a claim. So the fact is stated first, in one grep-checkable sentence, then
the case text.

#### The topology fact, as one lift-ready sentence

> **No production call site targets a terminal task state (`settling`, `confirmed`,
> `cancelled`, `cancel_requested`), and the one in-flight state the product does
> write — `unknown`, at `host.ts:1342` (no launch port installed) and `host.ts:1364`
> (launch failed), both with `releaseReservation: false` — has no reachable exit:
> of the six exits the state machine permits from `unknown` (`states.ts:93`), four
> have no non-test writer anywhere, `executing`'s only writer is the hand-run CLI
> with zero importers (`durability-runner.ts:91`), and `accepted`'s only production
> writer (`host.ts:1379`) is unreachable for such a task because `admit` refuses a
> task that still holds its slot (`host.ts:823-825`). Since a settlement is the act
> of leaving an in-flight state, no settlement can be delivered in any generation,
> stale or current — so no epoch or fencing token has anything to guard.**

Checkable by a reader with grep, in four commands:

```sh
grep -rn "to: '" packages/dsh-daily-work/src/*.ts | grep -v "\.test\."   # targets written, by file
grep -n "TERMINAL_STATES" -A 4 packages/dsh-daily-work/src/states.ts      # confirmed|cancelled
grep -n "already admitted as" packages/dsh-daily-work/src/host.ts         # admit refuses slot-holders
grep -n "unknown" packages/dsh-daily-work/src/states.ts                   # unknown is slot-holding (63), exits at 93
```

Measured behaviour, not just reading: a task driven to `unknown` by a failing launch
stays `unknown` with its reservation held through both a re-drain and a
`relaunchPrepared` attempt (`durability-advanced.test.ts`, test "and nothing can move
a task OUT of `unknown`").

#### The case text R0 can lift

> **`REC-09` / `REC-10` — NOT_CLAIMED (v1: FAIL, preserved).**
> v2 does not claim that a stale-generation settlement is refused.
>
> **The topology fact that makes it physically impossible:** no production call site
> targets a terminal task state (`settling`, `confirmed`, `cancelled`,
> `cancel_requested`), and the one in-flight state the product does write — `unknown`,
> at `host.ts:1342` and `host.ts:1364`, both holding the reservation — has no
> reachable exit: of the six exits permitted from `unknown` (`states.ts:93`), four
> have no non-test writer, `executing`'s only writer is the unreachable CLI
> (`durability-runner.ts:91`), and `accepted` is unreachable for such a task because
> `admit` refuses a task that still holds its slot (`host.ts:823-825`). A settlement
> is the act of leaving an in-flight state, so no settlement can be delivered from
> any generation, stale or current, and an epoch guard would have nothing to compare.
>
> **The guard is DELETED, as this arm requires:** `applyWorkerSettlement`, the
> `WorkerSettlement` type, the `RefusalLedger` and the `dsh_daily_work_refusals`
> domain are removed from `recovery.ts`, and the run record's `epoch` field is
> removed from `record.ts` (schema and initialiser). No unreachable guard is left in
> the tree.
>
> **What IS claimed instead:** authority for the `work` tool is bound to the exact
> live Agent object, enforced by `tool-protocol-guards.ts` comparing the live
> registry entry by object identity (`ctx.agents.get(id) === owner`). That covers
> the in-process resume case, which is reachable. The **cross-process generation
> case is NOT covered and v2 does not claim it.**
>
> **Evidence:** `qualification/results/R9-recovery-topology/TOPOLOGY.md` (caller
> graph with file:line citations and the corrected §1.5), `product-probe.txt` (record
> and domain shapes measured at the product tier), `readcompat-probe.txt`
> (legacy-store read compatibility), `BEFORE-durability-advanced-T9A.txt` (pre-change
> reproduction).

#### Phrasings R0 must NOT use, and why each is false

| Do not write | Why it is false |
|---|---|
| "the epoch guard is unreachable" | The guard no longer exists; it was deleted. |
| "a stale settlement is refused" | Not claimed — nothing refuses it because nothing can deliver it. |
| "the product never performs a terminal-state write" | Overclaimed: it writes `unknown` on the drain path (`host.ts:1342`, `:1364`). Say *terminal* state, and say what `unknown`'s fate is. |
| "the product cannot leave `accepted`" | A launch failure moves it to `unknown`, which is a different (and worse) fact. |
| "`reconcileRun` resolves `unknown`" | It has no production caller; its decisions are computed and never applied. |

#### The instrument rule this slice produced (for whoever writes the next enumeration oracle)

Stated generally, because it is the transferable lesson and it cost two rounds here:

> **An oracle that enumerates its own inputs by hand can hide the input that
> matters, and the hiding is invisible because the test passes. Derive the
> enumeration from the same source of truth the product uses, and pin both
> directions with a control.**

Both failure directions were produced by the same pattern in this slice:

| Direction | How | Example here |
|---|---|---|
| **Omission** | a hand-picked alternation in the pattern | `(?:settling|confirmed|cancelled|executing|cancel_requested)` omitted `unknown`, the one state the product writes |
| **Invention** | matching a declaration instead of a call | `to: 'settling' \| 'confirmed' \| 'cancelled'` is a type annotation, reported as a write |

The fix for both: derive the state set from the product's own constant
(`TERMINAL_STATES`), and require the syntactic terminator of a real call site
(`[,}]`) — with a positive and a negative control asserted in the test so a future
edit to the pattern cannot silently break either direction.

---

## 4. Every place that claimed the guarantee (for root to correct)

The source claims are already corrected in this worktree. The following **doc**
sites still describe the deleted mechanism and are root-owned — listed here rather
than edited, per the brief:

| # | File:line | What it claims now | Needed correction |
|---|---|---|---|
| 1 | `docs/GAPS.md:37` (G-SEAM-21) | "The run record's `epoch` guard is UNREACHABLE, so the field is inert… To close it, call `applyWorkerSettlement` from whatever path receives a worker settlement — that path does not exist yet" | Status is now **CLOSED BY DELETION**. The guard, `WorkerSettlement`, `RefusalLedger` and the `epoch` field are removed; the entry's "to close it" instruction is obsolete and would send a reader to wire a deleted function. |
| 2 | `docs/RECOVERY.md:10-15` | "the epoch guard (step 2) and the reconciliation path… have no production importer" | Step 2 (`:45-56`) describes a guard that no longer exists. Replace with the non-claim wording in §3.1. |
| 3 | `docs/RECOVERY.md:45-56` | "**An old epoch is never reused — but be precise about what enforces that.** The guard that would refuse a stale-epoch settlement (`applyWorkerSettlement` in `recovery.ts`) is real and tested and is **not reachable**" | The guard is deleted and the record has no `epoch`. Keep the "what IS enforced" half (object identity), replace the guard half. |
| 4 | `docs/DELIVERY.md:639-646` | "**The run record's `epoch` field is inert in the product.** The guard that would enforce it (`applyWorkerSettlement` in `recovery.ts`) is real and tested, but `recovery.ts` is **not reachable from any production path**" | Now: the field and the guard are **deleted**, with the topology reason; v2 does not claim the guarantee. |
| 5 | `docs/DELETE-AUDIT.md:146,195,454,648,687-690,702,738` | Inventory rows and §3.8.1 describing `recovery.ts` as owning the `epoch` guard and the `dsh_daily_work_refusals` domain; §3.8.1's "Next executable repair action" says to **wire** `applyWorkerSettlement` | The deletion audit is now stale on this row: the guard is gone and the domain is never opened. The recommended action is superseded by the topology measurement. |
| 6 | `docs/INVARIANTS.md:25` (INV-L3) | "Authority is bound to the exact live Agent object **plus run epoch**, not to a session-id string. A stale callback cannot write authoritative state." | The "plus run epoch" half names a deleted field. Reword to object identity alone, with the cross-process limit stated. **This is the one site that states the guarantee as an invariant**, so it is the most important to correct. |
| 7 | `ARCHITECTURE.md:54` | "every operation resolves the exact live Agent **and run epoch**" | Drop "and run epoch". |
| 8 | `README.md:291-293` | "**The epoch guard is unreachable** (`G-SEAM-21`), so the run record's `epoch` is inert" | Now deleted; restate as the non-claim. |
| 9 | `docs/decisions/AUDIT-REQUEST-acceptance-results.md:162,238` | F8 row: "`epoch` 字段在 `initialRunRecord` 设为 1 之后**无人 bump、无人读**" and §2.5 row 3 "未修（F8）" | The audit's own F8 finding is now resolved by deletion; the row should record the resolution. This file is the audit request and is historical, so root may prefer to leave it and point at the resolution instead. |

Also stale but **not** a guarantee claim, for completeness: `qualification/gates.json`
D10's note (`:962`) and `qualification/runners/build-gates.py:139` describe the
guard as existing with a "LIMIT: … a cross-process re-adoption still has no epoch
enforcement". The limit is still true; the guard is gone. Root re-derives gates, so
this is listed rather than changed.

### 4.1 Dangling-reference proof (post-deletion sweep)

| Question | Answer | Evidence |
|---|---|---|
| Any importer of `recovery.ts`? | Only `durability-records.test.ts:57`, importing **`relaunchPrepared`** — the kept D03 function, not the deleted half. | `grep -rn "from './recovery.ts'" packages/dsh-daily-work/src/` |
| Any config row / profile referencing the deleted domain? | None. `grep -rn "refus\|recovery" profiles/ packages/dsh-daily-work/cordis.patch.yml packages/dsh-daily-work/package.json` returns only unrelated prose about refusals in general. | same |
| Any exported symbol a future reader would think is load-bearing? | `recovery.ts` now exports exactly `RelaunchOutcome` and `relaunchPrepared`. Neither references an epoch. | `grep -n "^export" packages/dsh-daily-work/src/recovery.ts` |
| Any production code referencing the deleted symbols? | None — asserted by test over every production file with comments stripped. | `durability-advanced.test.ts` T9-A, "the deleted settlement machinery has no surviving reference" |
| Any production code referencing a run epoch? | None — asserted by test, with `kernel-lifecycle.ts` excluded by name as the different KERNEL epoch (G-SEAM-43). | same |
| Any persisted refusal data to migrate? | None on this machine: `find /d/DSH -name "dsh_daily_work_refusals*"` returns nothing, and the domain was never opened by any product path. | recorded in §2.1 |
| Stale build artifact? | Rebuilt; `lib/` reflects the deletion. | `tsc -p tsconfig.json` exit 0 |

