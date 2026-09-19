# M10 — shrink audit and delivery documentation: findings and the promotion decision

**Slice:** M10 of `MASTER_EXECUTION_PLAN.zh-CN.md` (收缩旧实现、文档与交付).
**Date:** 2026-09-20.
**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`.
**Snapshot:** the import graph was first read at `42c2485` and re-read at
`982e82b`; per-module rows in `docs/DELETE-AUDIT.md` state which commit they
describe. The tree advanced five commits during this slice (`ef08cee`, `041bd33`,
`2d4534f`, `b8f1ef2`, `982e82b`) and two of them repaired findings this audit
produced. See §5.
**Pinned upstream:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
(`dsh-v0.1.6-alpha.2`).

**Deliverables of this slice:**

| File | What it is |
|---|---|
| `docs/DELETE-AUDIT.md` | The shrink audit: real import graph, per-module classification, named-candidate verification, old-vs-new inventory. |
| `docs/DELIVERY.md` | The operations manual: install, doctor, start, pause, recover, shutdown, N, kernel state loss, artifact retention, permissions, known limits, backup, rollback, upgrade, gate reading. |
| `README.md` (edited) | Headline numbers corrected; the new architecture's invalidation recorded; a "proven but not part of the new target" section added. |
| `qualification/results/M10-shrink/FINDINGS.md` | This file. |

No file under `packages/` was modified by this slice. No code was deleted; the
delete audit proposes and the owner applies.

---

## 1. The promotion decision

The audit's rule, quoted from `MASTER_EXECUTION_PLAN.zh-CN.md` M10.5:

> READY only if all mandatory gates pass; NOT_RUN/FAIL/BLOCKED_EXTERNAL 不等于完成。

### Decision: **NOT_READY**

Two independent verdicts, and both are `NOT_READY`:

**Against the OLD spec** (`qualification/specs/gate-spec.json`, 104 cases, 88
mandatory, `required_for: daily_ready`), read from
`qualification/gates.json` on disk:

| Status | Mandatory (88) | All (104) |
|---|---|---|
| PASS | 75 | 85 |
| NOT_RUN | 10 | 10 |
| FAIL | 2 | 2 |
| BLOCKED_EXTERNAL | 1 | 1 |
| NOT_APPLICABLE | 0 | 6 (all `required_for: conditional`) |

**Against the NEW spec** (`acceptance-spec.json`, `schema_version: 2`, 112 cases,
`mandatory: true` on all of them): **112 / 112 are `NOT_RUN`**. The two specs share
**zero** case ids (verified by set intersection: empty). There is no mapping by
which any old PASS becomes a new PASS.

**This is the headline, and it is not a rounding of the above:** the architecture
this repository is now measured against is not implemented. The 85 old-spec PASSes
are real measurements of real mechanisms, and they are evidence for the *previous*
target.

### Why not "基本完成"

Because the mandatory set is not closed, and the four non-PASS categories are not
interchangeable:

- **Two mandatory gates FAIL with a measured cause** (E01, E06). Not gaps —
  measurements that contradict the requirement.
- **One mandatory gate is BLOCKED_EXTERNAL on a decision** (C01). Not on work.
- **Ten mandatory gates are NOT_RUN**, and one of them (A12) has a recorded
  partial that reached a real credential boundary.
- **All 112 new-spec cases are NOT_RUN**, including the vertical slice the
  architecture names as the most important first deliverable.

---

## 2. The four categories, kept separate

The task requires that a FAIL not be aggregated away and a BLOCKED not be
softened. So each non-PASS is listed with its category, its minimal reproduction,
its current source location, and the next executable repair action.

### (a) PROVEN AND PASSING

Not a summary — a pointer. 85 old-spec cases carry a PASS with at least one
evidence file whose sha256 is recorded, and `build-gates.py` refuses to emit a
PASS with no evidence on disk. The load-bearing ones, each with its evidence:

| Claim | Evidence |
|---|---|
| Ten children admitted through the real `ctx.subagents.startContinuable` seam on the production `AgentLoop`, ten distinct durable Sessions, ceiling enforced by DSH | `qualification/results/M3.2-N10-concurrency/`, `M9.12-scheduling/FINDINGS.md` |
| One completion admits exactly one replacement, without waiting for the wave; two concurrent drains on one free slot produce exactly one child | `M9.12-scheduling/FINDINGS.md` |
| A run survives a real `SIGKILL`; the record, task states and exact reservation recovered from a fresh process; reconciliation returns `unknown`, never a relaunch | `M4.1-process-kill/report-final.json` |
| The acceptance runner does not trust exit codes: an all-skipped suite and a zero-test run both carry a REAL exit 0 and are still non-PASS | `M9.1-acceptance-runner/receipt-all-skipped.json` |
| An A→B→A mutation during verification is caught by an immutable snapshot, and the in-place control arm proves endpoint hashing alone would have certified the tampered run | `M9.1-acceptance-runner/FINDINGS.md` |
| The extension is loaded by the real profile resolver; the `work` tool reaches the model (27 tools on the composed `daily-standard` preset) | `M9.17-b02-resolver/`, `M8.5-c2-real-boot/e2e-tool.json` |
| Cross-call state persists in a native PTY under `workspace-write` | `M9.2-terminal-advanced/` |

**Two corrections to this list, applied by this slice:**

1. **Ten of those PASSes are the M6 terminal block (T01–T10), and their subject is
   exactly what the new architecture removes.** T02's own stimulus is "经模型工具
   打开shell并发送IPython" — sending Python into a shell. They are honest
   measurements of a mechanism that leaves the product. `README.md` now says so
   explicitly, and `docs/DELETE-AUDIT.md` §4.2 lists every obsolete PASS.
2. **J01/J02/J03 were recorded `NOT_APPLICABLE` on the note "No dedicated kernel
   is implemented; the native terminal was qualified instead."** The new
   architecture makes that kernel mandatory, so those three become live
   obligations rather than closed conditionals.

### (b) HONEST FAIL, with a measured cause

**E01 — host credential isolation. FAIL.**

- **Minimal reproduction:** a confined child (`read-only` and `workspace-write`)
  reads a canary secret file outside the workspace root and prints it verbatim;
  exit code 0 in both modes. Writes outside are `EPERM` in both modes, which is
  what makes this a *write* boundary rather than a general one.
- **Current source location:** the boundary is
  `packages/sandbox/sandbox-windows-acl/src/index.ts:24-25` — "writes are
  restricted; reads, network, and process visibility are NOT
  (WRITE_RESTRICTED intersects only write accesses)". `SandboxPolicy` carries only
  `mode` + `workspaceRoot`, so **the seam has no read lever even in principle.**
  The only credential control anywhere is `scrubbedParentEnv()` in
  `@deepseek-ai/dsh-subprocess` — a name heuristic.
- **Evidence:** `qualification/results/M9.3-security-denial/FINDINGS.md`.
- **Next executable repair action:** this is not repairable inside the current
  sandbox seam, and the architecture's own answer is to stop relying on it —
  execute in the dedicated Linux VM where the read boundary is a real mount
  namespace, and record the Windows host as a UI/host surface only. The immediate
  executable step is **SEC-01** in the new spec: assert that native `read` and
  direct Python both fail to reach host `HOME`/`DSH_HOME`/`proc` **in the
  execution world**, not on this host.

**E06 — network/egress. FAIL.**

- **Minimal reproduction:** a confined child completes a real HTTP round trip to a
  loopback server and connects to a public address, under both `read-only` and
  `workspace-write`.
- **Current source location:** the only egress filter is `web-fetch-http`'s SSRF
  guard, which filters **that tool's URL** and has no relation to `ctx.sandbox`.
  It is bypassed by any shell command. `E06`'s evidence notes the seam README says
  file effects are the whole vocabulary — now executable evidence rather than a
  doc claim.
- **Evidence:** `qualification/results/M9.3-security-denial/FINDINGS.md`.
- **Next executable repair action:** **SEC-03** — assert that unauthorized direct
  connections are blocked by the OS/gateway of the execution world, and record the
  real result. On this host the honest result will be a second FAIL; the fix is the
  VM's network namespace, not a filter.

**Neither FAIL is aggregated, and neither is described as "not yet verified".**
Both were `NOT_RUN` before they were measured, and measuring them moved them to
`FAIL`, which understates less.

### (c) BLOCKED_EXTERNAL, with the exact missing authorization

**C01 — 强制10实际执行. BLOCKED_EXTERNAL.**

- **What is missing, exactly:** `compatibility.lock.json` records
  `runtime_authorization.live_provider_budget_authorized: false`,
  `budget_amount: null`, `currency: null`, `deadline: null`. The gate's live half
  is a run in which an **authorized frontier provider drives 30 non-empty
  children** (new-spec `UPG-07`); the old-spec T5 half is ten real children on a
  paid route.
- **What is NOT the blocker:** a key being present. `GAPS.md` G-EXT-02 and the
  lock both state that a present key does not authorize large paid evaluation.
  `A12`'s recorded partial confirms the boundary is CREDENTIAL and not composition
  — the SDK profile booted, reached `turn/start` with a real tool catalog, then
  stopped at `MISSING_CREDENTIAL`.
- **Current source location:** the configuration that would carry the
  authorization is `compatibility.lock.json` → `runtime_authorization`; the code
  that would consume it is not yet written (the budget ledger exists in
  `packages/dsh-daily-work/src/record.ts` / `counting.ts`, but no live provider
  route is authorized).
- **What is proven without it (T1, measured):** 20 tasks submitted against target
  N=10; ten admitted and ten refused; ten **distinct** children each reach a real
  model request in their own durable Session, each `status: running`, each
  `delegationDepthOf() === 1` with `origin: subagent` and the root as durable
  parent. Root exclusion is proven by a second case.
- **Next executable repair action:** the user sets
  `live_provider_budget_authorized: true` with an amount and a deadline, and the
  live run is executed against that budget. Until then the gate stays
  `BLOCKED_EXTERNAL` and the promotion decision stays `NOT_READY`.

**Also blocked, same cause:** the live halves of R01 (a real search API answering
in the ported provider's shape), U02 (a live research loop), U04 (a live paired
comparison), U05's new-version half (no installable new version — the checkout is
pinned and no network is authorized), and U03's live provider cost.

### (d) NOT_RUN, with the reason

**Mandatory old-spec gates:**

| Gate | Name | Why NOT_RUN |
|---|---|---|
| A12 | 真实日用host | Booted to the credential boundary and stopped. Real launcher, real port, real 401 fence, token→cookie→200 app shell, real `session/create` + `session/list` round trip all succeeded; **no model turn ran** because `DEEPSEEK_API_KEY` is absent from every source the credentials provider layers. No clean-shutdown claim: on win32 `child.kill` terminates rather than delivering a signal. |
| E02 | 控制面隔离 | Partial: the surface shape is proven (23 declared control-plane surfaces checked individually, **zero** exposed as model tools on a real 27-tool catalog; loopback returns 401 unauthenticated and 403 for a hostile `Host` on `/api`). A live model-to-control-plane probe has not run, because no provider is authorized. |
| E12 | 验证代码隔离 | Partial: the runner hands the child no credential name, no `DSH_HOME`, no control-plane handle (asserted clause by clause against the header text). **Limit stated:** there is no OS read boundary, so the runner cannot deny a path the child is *told*, and the runner does not redact the child's output. |
| R01 | 真实search链 | Partial: retrieval proven against a controlled fake; original fetch, range bound and citation proven against a real loopback server. The live half is blocked (see (c)). |
| U01–U06 | coding / research / sustained load / paired comparison / canary / rollback | Partial: each has a real executed rehearsal with its limits stated (e.g. U03's six-wave series with resource drift 0 but a modest range by design; U04 with `observationsPerGroup: 1`, no variance estimate and `winnerDeclared: false`; U06's rollback rehearsal over a temp home with the real effect ledger). None of them ran a live model, a live remote, or a real newer version. |

**New-spec cases: 112 / 112 `NOT_RUN`.** The reason is not authorization — it is
that the architecture is not built. Specifically:

| New-spec family | Cases | State | Reason |
|---|---|---|---|
| DEP (identity, locks, build coverage) | 8 | NOT_RUN | Some mechanisms exist (the kernel-held home lock is real and measured); the family as specified is not closed. |
| IPY (real IPython) | 8 | NOT_RUN | No reachable kernel. `packages/dsh-ipython/` has `protocol.ts` and `broker.py` but no `package.json`, no `lib/`, no bundle patch, no test. |
| BRG (programmatic call scope) | 8 | NOT_RUN | The `ProgrammaticCallScope` seam is not extracted. |
| DAT (data plane) | 8 | NOT_RUN | `artifacts.ts` + `observations.ts` exist as untracked in-flight work with `data-plane.test.ts` covering DAT-01…DAT-08, but **`gates.json` has not been regenerated against them** and no case has moved off `NOT_RUN`. |
| WEB | 8 | NOT_RUN | Layered coverage/capture not implemented. |
| HIS | 8 | NOT_RUN | `history-plane.ts` exists as untracked in-flight work with no importer. |
| REC | 8 | NOT_RUN | Kernel recovery has no kernel to recover. |
| SEC | 8 | NOT_RUN | SEC-01 and SEC-03 are the E01/E06 subjects, already honest FAILs on this host. |
| CAP | 8 | NOT_RUN | Hard 30 does not exist; `maxActiveSubagents` is per-family. |
| UI | 8 | NOT_RUN | No UI work exists in this repo; no `targetActiveChildren` control anywhere. |
| VER | 8 | NOT_RUN | `verification-gates.test.ts` (untracked, in flight) covers VER-01…VER-08; not yet reflected in any gate report. |
| ECO | 8 | NOT_RUN | No attempt-level billing against a live provider. |
| RES | 8 | NOT_RUN | No kernel, no backpressure. |
| UPG | 8 | NOT_RUN | UPG-07 needs an authorized provider; the rest need the built system. |

---

## 3. The delete audit: classification counts

Full detail in `docs/DELETE-AUDIT.md`. Counts were first taken at `42c2485` over
**21 non-test modules**, and the graph was re-read at `982e82b` over **25** (four
modules were added by other agents during the slice: `capacity`, `target-setting`,
`perf-metrics`, `web-provenance`). The table below is the `42c2485` classification,
which is what the audit's proposals are based on:

| Classification | Count | Modules |
|---|---|---|
| **KEEP** (reachable from an export and on a product path) | 11 | `host-plugin`, `host`, `record`, `states`, `counting`, `tools`, `tool-protocol-guards`, `homelock`, `launch-port`, `web-search-plugin`, `web-search` |
| **KEEP-FOR-SCHEMA** (owns persisted data) | 2 | `effects` (`dsh_daily_effects` v1), `recovery` (`dsh_daily_work_refusals`) |
| **PROPOSE-DELETE** | 1 | `durability-runner` — and the proposal is **relocate to `qualification/runners/`**, not delete, because it produces cited evidence |
| **INVESTIGATE** (graph cannot settle) | 3 | `effects` (product shape undecided), `verify` (product path vs qualification-only), `reconcile` (same question) |
| **IN-FLIGHT** (not judged) | 5 | `kernel-lifecycle`, `artifacts`, `history-plane`, `worktree-isolation`, `observations` |

At `982e82b` the reachable set is **13 of 25**, the two additions being `capacity.ts`
(`HARD_CHILD_CAPACITY = 30`) and `target-setting.ts` (the UI-settable
`targetActiveChildren` over `SettingsProvider.installSection`), both imported by
`host.ts`. `launch-port.ts` moved from DEAD to PROD at `2d4534f`.

`effects.ts` appears in two rows on purpose: it is KEEP-FOR-SCHEMA (the domain is
real and unopenable if removed without migration) **and** INVESTIGATE (the generic
framework has no production caller).

### The named candidates, each verified rather than assumed

| Architecture item | Verified result |
|---|---|
| The generic `effects.ts` framework is not a transaction system for IPython cells | **Confirmed.** `effects.ts` has one intra-package importer (`effects.test.ts`) and zero production importers. `EffectAdapter` has zero implementations outside the test file. **But it is not deletable**: `dsh_daily_effects` v1 is a real persisted domain, and the u06 rehearsal measured that a schema mismatch makes the domain **refuse to open**. Proposal: narrow to the read/reconcile path + keep the honesty literals; remove `runEffectProgram`, `resumeEffectProgram`, `classifyShellCommand`, `mayRunAutomatically`; a read-compat migration test is owed first. |
| Duplicate history CRUD should be replaced by native SessionQuery | **Not present.** No module implements a session-history store; `grep -rn "history"` over non-test sources returns one comment. There is nothing to delete, and reporting it as a completed deletion would be inventing work. |
| The double Goal/work driver should be ONE continuation owner | **The handover exists and is correct, and its production caller was missing — now wired.** At `42c2485`, `takeContinuation` had zero production callers (only `goal.test.ts` and `isolation.test.ts`), so the Goal driver was never disarmed by a run and two continuation owners could drive one root. Commit `982e82b` takes it at `createRun` and stores the result on the run record (new optional `continuation` field). Code and test tier, not boot tier. See §3.9 below and `docs/DELETE-AUDIT.md` §3.2.1. |
| A second model-facing execution surface must leave the daily preset | **Present in the preset, not added by this package.** The measured catalog on `daily-standard` is 27 tools including `pwsh` and no `python_exec`. The row belongs to the stock preset. |
| "Truncate-then-spill counted as complete retention" | **Present upstream and not implemented here.** `spill-local` writes to a per-process temp root (`mkdtempSync(join(tmpdir(), 'dsh-spill-'))`) because the base bundle mounts it with no `root` config, and the locator handed to the model is an **absolute filesystem path** with the hint `'Use read with offset/limit, or grep this path to search within it.'` So the model *is* told to read a host path — the pattern the architecture requires replacing. The replacement does not exist. |
| The model reading host spill paths directly | **Same finding.** No unified data capability to replace it with. |
| Shell must leave the daily preset / `python_exec` is the surface | **Not built.** See §2(d) IPY row. |

### The finding this audit produced, and its repair

Following the import graph rather than module names found that
**`WorkService.setLaunchPort` had zero production callers**: `host-plugin.ts`
constructed the service, opened the domain and never installed a port, so a model
`submit` on the composed profile recorded a task, transitioned it to `unknown`
with `uncertainty: 'no launch port installed'`, and launched nothing. The N=10
result was a result about the service with a port a **test** had installed.

Commit `2d4534f` — *"wire the production launch port: the product could not launch
a child at all"* — landed while this audit was being written and fixes it:
`createRun` now calls `installDefaultLaunchPort(root)`, and the bundle patch names
`subagentProvider: spawn`. The three design choices in that repair are the correct
ones (it does not overwrite a test's scripted port; it binds at `createRun` where
the exact live root `Agent` is in hand rather than to a session-id string; it
leaves the port unset when `ctx.subagents` is absent so the drain path still
reports honestly).

Commit `b8f1ef2` then added `production-port.test.ts`, which installs **nothing**
and asserts the drain reaches the real `startContinuable` seam — the test whose
absence let the defect survive, and the oracle/scenario mismatch in miniature.

**What this does not establish:** the wiring is a **code path plus a test-tier
result, not a measured boot**. The N=10 evidence predates the change, no gate
report has been regenerated, and no `dsh --profile daily` boot has re-asserted it.
That is the first thing the next slice should close.

### 3.9 A defect class, not three incidents — and the third is still OPEN

Following the graph produced the same shape **three times**: a mechanism that is
implemented, well-tested, and **not reachable from any production path**. The tests
passed in all three cases because they call the mechanism *directly*, so they
proved the mechanism while the product never invoked it.

| # | Mechanism | Found at | State |
|---|---|---|---|
| 1 | `launch-port.ts` / `setLaunchPort` | `42c2485` | **Fixed** — `2d4534f` + test `b8f1ef2`. A `submit` launched nothing. |
| 2 | `takeContinuation` | `42c2485` | **Fixed** — `982e82b`. Two continuation owners could drive one root. |
| 3 | `recovery.ts` / `applyWorkerSettlement` — the run `epoch` guard | verified at `982e82b` | **OPEN** |

**Instance 3, in detail.** `record.ts:410-414` documents `epoch` as *"bumped when a
run is re-adopted by a new host generation. A callback carrying a stale epoch must
be rejected rather than silently accepted."* The guard is real: `applyWorkerSettlement`
(`recovery.ts:254`) compares the settlement's epoch to the record's and refuses the
authoritative write (`recovery.ts:274-276`), leaving the task unmoved and its
reservation held, and writes the refusal to a separate `dsh_daily_work_refusals`
domain. It has three real test cases.

**But the graph shows `recovery.ts` is unreachable from production.** Verified at
`982e82b`: `recovery.ts` has **zero non-test importers** (only
`durability-records.test.ts`); it is **not** in the closure of the five
`package.json` `exports` roots; and `applyWorkerSettlement` has **zero callers**
outside its own module and its test.

**Therefore the epoch is inert in exactly the way the launch port was.**
`initialRunRecord` sets `epoch: 1` and no production code reads or writes it
afterwards — nothing bumps it, and the only comparison lives in the unwired guard.
A stale callback carrying an old epoch **cannot** be rejected on epoch grounds in
the product. What *is* enforced is object identity via `tool-protocol-guards.ts`
(a real monotonic check, mounted at the host plane, covering the in-process resume
case); the cross-process-generation case is the one the epoch field promises and
does not deliver.

**A correction to my own earlier claim, and the lesson.** An earlier revision of
this file and of `README.md` said the epoch was enforced in `recovery.ts` "just not
wired", and on that basis treated README's original sentence *"the record's `epoch`
field is inert"* as stale and removed it. **That was wrong.** The guard's existence
is not enforcement; reachability is. The original sentence was accurate. The
mistake is the more instructive because this same audit had **just** found the
identical shape in `takeContinuation` — the reviewer had the pattern in hand and
still read the presence of a guard as the presence of enforcement.

`tool-protocol-guards.ts:61-67` had the correct statement all along: *"It does not
make the run record's `epoch` field meaningful … no code reads or writes it after
`initialRunRecord` sets it to 1 … the epoch is an unused field."*

**Next executable repair action.** Either wire `applyWorkerSettlement` into the
path that actually receives a worker settlement — same shape as `982e82b`, at the
point where the exact live run and root are in hand — or, if no such settlement
path exists yet in the product, **mark `epoch` unused in `record.ts`** and delete
the "must be rejected" sentence, keeping the guard as qualification-only. Either is
defensible. Leaving a field documented as enforced while its guard is unreachable
is not, because it is the kind of claim a reader will act on.

**One further gap, adjacent rather than identical.** The new `continuation` field
is written by `createRun` and **read by nothing** — no production code, and no test
asserts on it. The write is on the product path, so it is not instance 4 of the
class; but if the field's purpose is that a reader can *verify* the one-owner rule,
something has to read it. Named here so it is not discovered later as a surprise.

**The standing check.** Steps: (1) take the `exports` roots from `package.json`;
(2) close over intra-package relative imports; (3) list every non-test module not
in that closure; (4) grep each for callers outside `*.test.ts`. Anything whose only
callers are tests is a candidate. It is cheap, it found all three instances, and it
should be run as a standing check rather than a one-off audit step.

---

## 4. Old report vs new: what does not carry over

`qualification/gates.json` is preserved unchanged as an immutable audit snapshot.
Its numbers do not transfer, for three independently verifiable reasons:

1. **Zero id overlap.** The old spec (104 cases, ids `A01…J03`) and the new spec
   (`schema_version: 2`, 112 cases, ids `DEP-01…UPG-08`) share **no** case id.
2. **Its own generator says so.** `gates-summary.json`:
   `promotion_decision: "NOT_READY"`, `promotion_reason: "Mandatory gates remain
   NOT_RUN or BLOCKED_EXTERNAL. No daily promotion is claimed."`
3. **Its evidence has already drifted.** Re-hashing all **127** evidence references
   against disk: **124 match, 3 do not.** T05, T06 and T08 cite
   `qualification/results/M9.2-terminal-advanced/FINDINGS.md` at
   `1f1408e7f20c6a8639534032de20cb9cadd37a582da42c99e8e1a34583978fe5` while the
   file on disk hashes
   `615adaad87d29e3c…`, because it was extended with the workspace-write
   confinement arm after the report was generated. The PASSes are not withdrawn,
   but the report no longer describes the files it points at.

**Obsolete PASSes**, listed in full in `docs/DELETE-AUDIT.md` §4.2:
T01–T10 (the whole terminal block, whose subject leaves the model's surface),
E09 (a shell classifier — same), J01–J03 (recorded `NOT_APPLICABLE` on the note
that no dedicated kernel is implemented; now mandatory), and A08 (the stock
baseline itself changes once the shell leaves the preset).

**Everything else** (A01–A12, B01–B10, C02–C18, D01–D14, E01–E12, F01–F08,
R02–R08, U01–U06, W01–W03) measures this package's own mechanisms — admission,
budget, durability, the acceptance runner, the tool protocol, the guard. Those
subjects survive the architecture change, so those PASSes remain meaningful **for
the old spec**. They are not new-spec PASSes.

---

## 5. Three process findings worth keeping

1. **The tree moved five commits during this slice, and two of them repaired
   findings this audit produced.** `2d4534f` (*"wire the production launch port: the
   product could not launch a child at all"*) and `982e82b` (*"wire the Goal
   handover: takeContinuation had zero production callers"*) both close gaps
   recorded in §3; `b8f1ef2` adds the regression test that would have caught the
   first. Both states are recorded in `docs/DELETE-AUDIT.md` rather than only the
   final one, because a snapshot that silently updates to the newest state cannot be
   checked. **Consequence for a reader:** the tables describe `42c2485` and the
   graph was re-read at `982e82b`; the method (four lines of Python over
   `from './x.ts'` specifiers plus a closure from the `exports` roots) is what should
   be re-run, not the tables re-trusted.

   **The process lesson is the same one `G-FIX-04` already recorded, in a new
   place.** There: a gate whose oracle is weaker than its scenario passes while the
   product is broken. Here: the port seam exists so the top-up logic can be driven
   by a scripted adapter, so all eight test files that install a port passed while
   the composed product could not launch a single child; and the Goal tests call
   `takeContinuation` **directly**, so they proved the mechanism while the product
   still had two continuation owners. A seam that makes a component testable also
   makes the product's own wiring invisible to those tests, and only an
   import-graph or no-install test closes that gap.

2. **The class recurred a third time, and the third is still open.** §3.9 records
   it: `recovery.ts` is not reachable from production, so the run `epoch` guard it
   holds is inert. **And this slice initially got that wrong** — it removed README's
   accurate *"the record's `epoch` field is inert"* sentence on the reasoning that
   the guard existed and was merely unwired. The presence of a guard is not
   enforcement; reachability is. The error is worth recording because the same
   audit had **just** found the identical shape in `takeContinuation` and the
   reviewer still made it, which is a measure of how persuasive a well-commented
   un-called module is.

3. **`tsc -p tsconfig.json` is a false pass and was already documented as one.**
   It excludes `src/**/*.test.ts`, so it exits 0 with or without a test file
   present. `tsconfig.check.json` keeps identical strict flags and clears only that
   exclude. This slice did not run either; it records that any gate whose evidence
   is "the tests type-check" must cite the `.check` config.

---

## 6. What this slice did NOT do

- **It did not delete anything.** Every delete is a proposal with its evidence and
  its migration cost stated.
- **It did not edit `packages/`.** Other agents are working there; the tree changed
  under this slice five times, and at one point a file was mid-edit and did not
  parse.
- **It did not re-run any gate.** `qualification/gates.json` was read, not
  regenerated. No new-spec case moved off `NOT_RUN`.
- **It did not verify the in-flight modules.** `artifacts.ts`, `history-plane.ts`,
  `kernel-lifecycle.ts`, `worktree-isolation.ts`, `observations.ts`,
  `perf-metrics.ts`, `web-provenance.ts`, `data-plane.test.ts`,
  `verification-gates.test.ts` and `packages/dsh-ipython/` are classified IN-FLIGHT
  with no verdict, because judging a module mid-authoring would misreport it.
  `production-port.test.ts` is the exception: it is named in §3 because it closes a
  specific finding, and its existence is verified, not its pass/fail result.
- **It did not run the test suite.** The counts quoted in `README.md` and
  `docs/DELIVERY.md` come from `vitest list` at `2d4534f` (**592 collected across
  37 files**) and from the per-slice `tests.txt` files under
  `qualification/results/`; no full-suite pass/fail run is recorded here. The
  figure is deliberately labelled as **collected**, not **passing**. It also could
  not be re-verified later in the slice: the package is under active concurrent
  edit and at one point the tree did not parse (`src/host.ts:802`, a transient
  `PARSE_ERROR` from `vite:oxc`), which is itself a reason a documentation slice
  should quote a pinned commit rather than "current".

## 7. The one-sentence state

**The old target is 75/88 mandatory gates closed with two honest FAILs and one
external block; the new target is 0/112 because it is not built; the promotion
decision is `NOT_READY` on both readings; the missing authorization is a live
provider budget recorded as `live_provider_budget_authorized: false`; and three
mechanisms were found proven-but-unreachable, of which two are now wired and the
run-`epoch` guard is still open.**
