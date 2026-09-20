# DELETE AUDIT — what the shrink proposal is, and what the evidence supports

> **This document PROPOSES. It does not delete.** Nothing under `packages/` was
> modified by the slice that produced this file. The owner of each module applies
> (or refuses) the proposals here.
>
> **What this document is now, for a reader arriving fresh.** It began as a shrink
> audit of `packages/dsh-daily-work/src/` and it is still that; §5b, added for the
> delivery pass, is the part that answers the question its title asks — **what did
> this project delete or replace from the stock composition.** The answer is in
> §5b and it is short: two config overrides, seven inserted rows, one duplicate
> insert removed, no deletions. If you are reading this to find out whether the
> delivery quietly removed a stock component, read §5b and skip the rest.
>
> **Snapshot.** Every claim below is derived from the real import graph of
> `packages/dsh-daily-work/src/`, parsed from the `from './x.ts'` specifiers of
> every `.ts` file in `src/`, plus `package.json` `exports`, plus `grep` over
> `profiles/`, `qualification/` and `packages/dsh-daily-work/cordis.patch.yml` for
> every out-of-tree reference. Where a number could not be verified it is marked
> **UNVERIFIED** rather than estimated.
>
> **The graph in §1 is a snapshot at `2d4534f` and has since moved.** It has been
> re-run for the delivery pass and lives, with its runner, at
> `qualification/results/R3-unwired/import-graph.{txt,mjs}`. The differences are
> called out where they matter (§1, §3.6, §3.7, §5), and the standing advice is
> unchanged: **re-run the graph rather than trusting any table here.**
>
> **The tree moved during this audit — five commits, two of which repaired findings
> this audit produced.** The graph was first read at `42c2485` and re-read at
> `982e82b`; per-module rows state which commit they describe. The five commits are
> `ef08cee`, `041bd33`, `2d4534f` (*"wire the production launch port: the product
> could not launch a child at all"*), `b8f1ef2` (*"test the production launch path
> with NO test-installed port"*) and `982e82b` (*"wire the Goal handover:
> takeContinuation had zero production callers"*). §3.2 and §3.8 record the
> defects, the repairs and the regression tests, because the sequence is itself the
> evidence that following the import graph finds defects the test suite
> structurally cannot.
>
> **Also untracked at this snapshot:** several new modules (`artifacts.ts`,
> `history-plane.ts`, `kernel-lifecycle.ts`, `observations.ts`,
> `worktree-isolation.ts`, `perf-metrics.ts`, `web-provenance.ts`) and test files
> (`data-plane.test.ts`, `verification-gates.test.ts`, `production-port.test.ts`,
> plus recon scaffolding `probe-m7.test.ts` and `spike.test.ts`) and a new package
> `packages/dsh-ipython/`. They are another agent's in-flight work, classified as
> **IN-FLIGHT** below with no keep/delete verdict: classifying a module
> mid-authoring would misreport it.
>
> **THAT SNAPSHOT IS NOW OLD, AND THIS NOTE IS THE CORRECTION.** The tree has moved
> on: most of those modules are now reachable from a real export, the two
> scaffolding test files have been deleted, and `packages/dsh-ipython/` is a
> complete bundle with a `package.json`, a `lib/`, a `cordis.patch.yml`, a preset
> row and a passing suite. **§3.6, §3.7, §5 and the new §5b state what is true
> now**; the older sentences are kept where they are load-bearing history and are
> marked as snapshots where they are not. The one durable warning is the method,
> not the tables: **re-run the graph rather than trusting any table in this file**,
> and prefer `qualification/results/R3-unwired/import-graph.txt` when the two
> disagree.

## 0. The rule this audit applies, and the rule it refuses to apply

`ARCHITECTURE.zh-CN.md` §17 requires both of these at once:

> "新增能力不代表 repo 应越来越大" … "最终 repo 应比把所有历史设计继续叠上去明显更小"

and

> "对 `effects.ts` 等文件，不能仅凭名字就删除。先确认实际 import graph、调用路径和已存
> schema，保留必要数据迁移与回归测试；删除的是未承担实际产品职责的抽象，不是删除真实故障处理。"

So name alone decides nothing. The classification below uses four questions, in
this order:

1. **Is it reachable from a `package.json` `exports` entry?** That is what the
   profile resolver can load, and therefore what "production" means here.
2. **Does a real production path reach it?** For this package that means: is it
   reachable from one of the five exported entry points, and is the resulting
   object actually installed by a caller that is not a test?
3. **Does it hold a persisted schema?** If yes it needs read compatibility or a
   migration regardless of whether anything calls it today, because the data
   exists on disk.
4. **What is its test coverage?** A module with no production importer but real
   regression tests is a different object from a module with neither.

The four classifications:

| Class | Meaning |
|---|---|
| **KEEP** | On a product path reachable from an exported entry point. |
| **KEEP-FOR-SCHEMA** | Not on a product path today, but owns a persisted domain/schema or a durable read path. Removal needs a migration or an explicit read-compat decision. |
| **PROPOSE-DELETE** | No production importer, no persisted schema, no out-of-tree consumer. |
| **INVESTIGATE** | The graph cannot settle it — usually because the missing piece is *outside* this repo (a wiring that was never built, or a caller that lives in another agent's in-flight work). |

## 1. The real import graph

`package.json` declares five `exports`, so there are five production roots:

```
dsh-daily-work/host                   -> lib/host-plugin.js   -> src/host-plugin.ts
dsh-daily-work/service                -> lib/host.js          -> src/host.ts
dsh-daily-work/tool-protocol-guards   -> lib/tool-protocol-guards.js
dsh-daily-work/tools                  -> lib/tools.js
dsh-daily-work/web-search             -> lib/web-search-plugin.js
```

Transitive closure from those five roots, using only intra-package relative
imports (external `@deepseek-ai/*` edges are not followed — they are the pinned
checkout, not this package):

```
PRODUCTION-REACHABLE (11 modules) at 2d4534f:
  host-plugin.ts   -> host.ts
  host.ts          -> counting.ts, homelock.ts, launch-port.ts, record.ts, states.ts
  tools.ts         -> host.ts            (type-only)
  tool-protocol-guards.ts -> tools.ts    (type-only)
  web-search-plugin.ts    -> web-search.ts
  counting.ts      -> record.ts, states.ts
  record.ts        -> states.ts
  launch-port.ts   -> host.ts            (type-only)
```

`launch-port.ts` moved from DEAD to PROD during this audit (`2d4534f`), and
`capacity.ts` / `target-setting.ts` were added by another agent and are reachable
from `host.ts`. See §3.2 and §3.8.2.

> **The graph above is a snapshot at `2d4534f` and is now out of date.** It was
> re-run for this delivery pass and is kept at
> `qualification/results/R3-unwired/import-graph.txt` (with its runner,
> `import-graph.mjs`, so it can be re-run rather than trusted). The current shape:
> **`package.json` declares eleven exports**, not five; 78 `src/` files of which 31
> are non-test; **25 reachable, 6 unreachable**. The unreachable six are
> `durability-runner.ts`, `effects.ts`, `kernel-lifecycle.ts`, `perf-metrics.ts`,
> `reconcile.ts`, `recovery.ts`. Newly reachable since this snapshot: `artifacts.ts`,
> `observations.ts`, `history-plane.ts`, `web-provenance.ts`,
> `worktree-isolation.ts`, `verify.ts` (via the `writers` export), plus the four
> newer entry plugins. **`launch-port.ts` is still listed above as type-only into
> `host.ts`; the current graph shows it as a real non-test importer of `host.ts` and
> `host.ts` importing it back**, which is the wiring `2d4534f` added.

Everything else in `src/` is **not** reachable from an export at `2d4534f`:

| Module | Intra-package importers | Out-of-tree importers | Persisted schema |
|---|---|---|---|
| `effects.ts` | `effects.test.ts` | `qualification/results/M9.20-real-tasks/u06-rollback.mjs` (dynamic `import()`) | `dsh_daily_effects` domain, `EFFECT_SCHEMA_VERSION = 1` |
| `verify.ts` | `verify.test.ts`, `real-tasks.test.ts`, `verification-gates.test.ts` | `qualification/runners/acceptance.mjs` (dynamic `import()`) | none; emits `dsh-daily-work/acceptance-receipt@1` JSON |
| `reconcile.ts` | 6 test files + `durability-runner.ts` | none | none |
| `recovery.ts` | `durability-records.test.ts` (imports `relaunchPrepared` only) | none | **none — the `dsh_daily_work_refusals` domain and its `RefusalLedger` were DELETED** (F8 / REC-09 / REC-10; §3.8.1). The module now exports exactly `RelaunchOutcome` and `relaunchPrepared`, neither of which mentions an epoch. |
| `durability-runner.ts` | none (a CLI entry by `node --import tsx`) | `docs/OPERATIONS.md` documents the command | none |

**`verify.ts` has since left this table**: the current graph shows it reachable via
the `writers` export, imported by `writers-plugin.ts` and `worktree-isolation.ts`.
The other four are still unreachable, plus `kernel-lifecycle.ts` and
`perf-metrics.ts`.

**Note on the two dynamic importers.** `acceptance.mjs` and `u06-rollback.mjs`
import from `packages/dsh-daily-work/src/*.ts` by absolute path via
`pathToFileURL`. They are qualification runners, not shipped product, so they are
recorded as **test-tier consumers with a file-path dependency**, not as
production importers. They are nevertheless real callers: deleting `verify.ts` or
`effects.ts` breaks a runner that has been executed and whose output is cited in
`gates.json`.

## 2. Per-module classification

### 2.1 KEEP — on the product path

| Module | Lines | Why it is on the product path |
|---|---|---|
| `host-plugin.ts` | 46 | The `/host` export. Mounted by the bundle patch (`cordis.patch.yml`, row `daily-work-host`). |
| `host.ts` | ~1150 | The service class: run record, admission state machine, budget reservation, coalesced drain, production launch-port binding. Reached by `/host`, `/service`, `/tools`. |
| `record.ts` | 773 | The durable run record schema (`dsh_daily_work` domain, `WORK_SCHEMA_VERSION = 1`, single table `runs`). |
| `states.ts` | 116 | `ADMISSION_STATES` + `holdsSlot` + `assertTransition`; `holdsSlot` is the single occupancy predicate INV-C1 names. |
| `counting.ts` | 267 | The precise counts the model's `status` action returns. |
| `tools.ts` | 200 | The agent-scoped `work` tool, mounted by the `daily-standard` preset row `daily-work-tools`. |
| `tool-protocol-guards.ts` | 142 | The exact-owner guard for `work`, mounted as `daily-work-tool-protocol-guards` in the bundle patch. |
| `homelock.ts` | 295 | The deployment-boundary lock. Called unconditionally from `WorkService.open()`. |
| `launch-port.ts` | 100 | The real `ctx.subagents.startContinuable` bridge. **Moved from DEAD to PROD at `2d4534f`** — see §3.2. |
| `web-search-plugin.ts` | 83 | The `/web-search` export, mounted as `daily-web-search`. |
| `web-search.ts` | 247 | The ported search provider behind that plugin. |

**`homelock.ts` is KEEP with a caveat the graph cannot express.** It is reachable
and called, but it is **inert by default**: `host.ts:256` returns immediately when
`config.homeLockPath` is undefined, and `grep` over `profiles/`,
`packages/dsh-daily-work/cordis.patch.yml` and the resolved evidence graphs finds
**no configuration that sets it**. So the D02 PASS ("a real second process is
refused") is a PASS about the guard *when configured*, and the shipped default
still has no cross-process protection. This is recorded in README's
"what is NOT proven" section; it is not a delete proposal.

### 2.2 KEEP-FOR-SCHEMA — owns persisted data

| Module | Persisted object | What removal costs |
|---|---|---|
| `record.ts` | `dsh_daily_work` domain v1, table `runs` | Already KEEP. Listed here for completeness: the run record is the only durable artifact this project owns. **Its field set changed during this audit — see §2.5.** |
| `effects.ts` | `dsh_daily_effects` domain v1, table `operations` | **Read compatibility or an explicit tombstone.** The domain facility refuses to open on a record that does not match its schema — measured, in `qualification/results/M9.20-real-tasks/u06-rollback.mjs` step R8a: `DomainError: domain 'dsh_daily_effects': stored record 'eff_…' in table 'operations' does not match its schema`. Removing `effects.ts` without a migration therefore makes a store that contains effect records **unopenable by any version that keeps the domain**, and makes the records unreadable by any version that drops it. |
| `recovery.ts` | ~~`dsh_daily_work_refusals` domain (`RefusalLedger`)~~ **none: DELETED** | This row is superseded. The `RefusalLedger` and its separate domain were **deleted rather than wired** under F8 / REC-09 / REC-10 (§3.8.1): the guard they supported guarded a path that does not exist. There is therefore no refusal history to preserve or migrate, and no `dsh_daily_work_refusals` store to open. `recovery.ts` retains only `relaunchPrepared`, which is a DIFFERENT claim (gate D03) and is deliberately kept. **Note:** the module is still the third instance of the not-reachable defect class for its remaining half — see §3.8.1. |

### 2.3 PROPOSE-DELETE

Only **one** module satisfies all three conditions (no production importer, no
persisted schema, no out-of-tree consumer):

| Module | Lines | Evidence |
|---|---|---|
| `durability-runner.ts` | 257 | Zero importers in `src/` (verified: no `from './durability-runner'` anywhere). No `exports` entry. Not referenced by `cordis.patch.yml`, `profiles/`, or any runner. Its only documented consumer is the command in `docs/OPERATIONS.md`. |

**But the honest recommendation is not "delete".** It is the M4 durability
runner — the fork/SIGKILL/reopen harness whose output
(`qualification/results/M4.1-process-kill/report-final.json`) is the evidence
behind gates D03–D09. Deleting it deletes the ability to re-run those gates. The
proposal is therefore: **move it out of `src/` into `qualification/runners/`**,
which is where the other standalone executables already live
(`acceptance.mjs`, `verify-b02.mjs`, `u05-canary.mjs`, …). That is the same
shrink the architecture asks for — `src/` stops carrying a non-library file — with
no loss of evidence.

### 2.4 INVESTIGATE — the graph cannot settle these

| Module | Lines | Why it is unresolved |
|---|---|---|
| `effects.ts` | 1373 | **The named candidate.** See §3.1. It is not deletable as written (schema) and not reachable as written (no production importer), so the question is not "keep or delete" but "what is the narrow implementation that a real external-effect adapter actually calls". No such adapter exists in this repo. |
| `verify.ts` | 1163 | Not reachable from any export, yet it is the M9.1 acceptance runner with 36 tests and a CLI in `qualification/runners/acceptance.mjs`. The architecture wants an independent verification authority; today that authority is a **qualification-time tool**, not a product surface. Either it becomes a product path (a tool the run can invoke) or it is honestly labelled qualification-only. Both are defensible; the graph does not choose. |
| `launch-port.ts` | 100 | **Resolved during this audit.** At `42c2485` it was DEAD; at `2d4534f` it is PROD. See §3.2.2. |
| `reconcile.ts` | 238 | Not reachable from production, but it is the module that decides `unknown` vs `not_started` after an interruption, and `host.ts` has no call into it. `recovery.ts` depends on its decisions. Same question as `verify.ts`: product path or qualification-only. |
| `recovery.ts` | 255 | Not reachable from production. **Its `epoch` guard half has since been DELETED** (F8 / REC-09 / REC-10 — §3.8.1); the module now exports only `relaunchPrepared`, which its header states exists to close gate D03 ("a reconciled `prepared` task would otherwise sit there forever"). Reconciliation is still not wired into the host, so D03's PASS describes the mechanism, not a live recovery path. |

### 2.5 The run record's field set, and the `continuation` addition

`runRecordSchema` (`record.ts`) is the only durable schema this project owns, so
its field list is recorded here rather than left implicit. Fields at `982e82b`:

```
version · runId · epoch · rootSessionId · authorizationRef · phase
requestedTarget · maxDepth · policyDigest
continuation?          <- ADDED by 982e82b, OPTIONAL
budget · tasks · outbox · lastReconciledRefs · terminalTombstones
createdAt · updatedAt
```

**`epoch` was in that list and is no longer in the schema.** It was removed under
F8 / REC-09 / REC-10 (§3.8.1) along with the guard that read it. The removal is
read-compatible: a stored record that still carries the old key parses, and the
extra key is dropped. The current field list is therefore the above minus `epoch`.

**The `continuation` field is new and optional, and the optionality is
load-bearing rather than cosmetic.** `continuationHandoverSchema` holds
`{ goalPresent, disarmed, objectivePreserved?, revisionUnchanged?, phaseBefore?,
phaseAfter?, activationAfter?, note }`, and `initialRunRecord` writes it only when
the caller supplies one. The reason recorded in the code is the one a reader needs:
a run whose continuation was **never handed over** is indistinguishable from one
whose handover was recorded as **"no goal present"** unless the outcome is on the
record, and those are different facts about who drives the root.

**Why optional and not required:** a record written before the field existed must
still validate on read. Refusing to open such a record would be a migration the
storage domain cannot perform, and the honest answer for an old run is *"the
handover was not recorded"*, not *"the run is invalid"*. This is the same
read-compatibility discipline §2.2 requires of `effects.ts`, applied correctly and
in advance.

**One thing the new field does NOT yet have.** `grep` for reads of
`.continuation` outside `record.ts` returns **nothing** — the value is written and
never read by any production code, and no test asserts on it yet either. So at
`982e82b` the field is a **record of the handover, not a check on it**. That is a
defensible first step (the fact is now durable and auditable), but it should be
named: if the intended purpose is that a reader can *verify* the one-owner rule,
something has to read the field. It is not the defect class of §3.8 — the write is
on the product path via `createRun` — but it is adjacent to it.

## 3. The named candidates, each checked against the graph

### 3.1 `effects.ts` — the generic effect framework

**Architecture requirement:** "`effects.ts` 通用 framework 不作为所有 IPython cell
的事务系统；只有实际外部 effect adapter 需要且有明确 postcondition 时保留被调用的窄实现。"

**What the graph shows.** `effects.ts` has exactly **one** importer in the package:
`effects.test.ts`. There is **no production importer at all** — not from
`host.ts`, not from any export, not from the bundle patch. The only non-test
caller anywhere in the tree is `qualification/results/M9.20-real-tasks/u06-rollback.mjs`,
which loads it by absolute path to rehearse a rollback.

**What that means, stated precisely.** The architecture's condition for keeping
it is "被实际外部 effect adapter 调用" — *called by a real external effect
adapter*. There is no such adapter:

- `EffectAdapter` (`effects.ts:273`) is an interface with **zero implementations**
  outside `effects.test.ts` (`class FakeAdapter implements EffectAdapter`,
  `effects.test.ts:98`).
- `EffectLedger` (`effects.ts:440`) has **zero production constructions**.
- `classifyShellCommand` / `mayRunAutomatically` (`effects.ts:1281`, `:1371`) have
  zero callers outside the test file and effects.ts itself.

**But deletion is NOT the proposal, and the reason is the schema.** The domain
`dsh_daily_effects` is a real persisted object with `EFFECT_SCHEMA_VERSION = 1`,
and the u06 rehearsal measured what happens when a store carrying effect records
is opened by code whose schema does not match: the domain facility **refuses to
open at all**. So:

- **PROPOSE (narrow)**: keep `effectRecordSchema`, `effectDomainSpec`,
  `EffectRecord`, `identify`, `canonicalJson`, `parameterDigestOf`, and the
  `EffectLedger` methods that read/reconcile a stored record — these are what read
  compatibility requires, and `EffectLedger.reconcile` is what the u06 rehearsal
  actually calls.
- **PROPOSE (remove from the product surface)**: `runEffectProgram`,
  `resumeEffectProgram` (`effects.ts:1054`, `:1110`) — a program-level driver with
  no caller — and `classifyShellCommand` / `mayRunAutomatically` /
  `CLASSIFIER_LIMITS` (`effects.ts:1142`–`:1373`), which are a shell-command
  classifier. E09 measured that classifier being defeated four ways and its own
  note says "This is a refusal device, not a control". A refusal device with no
  production caller is exactly the "抽象 that does not carry a real product
  responsibility" the architecture names.
- **DO NOT remove**: `EffectLedger.reconcile` and the stored-status vocabulary
  (`confirmed | unknown | not_started | conflict`), and the `reverted: false` /
  `replayedWholeProgram: false` literal types. Those are the *honesty* half, they
  are what E07/E08/E10/E11 measure, and they are load-bearing for any future
  adapter.
- **MIGRATION OWED before any of the above**: a read-compat test that opens a
  store containing a v1 effect record. Without it, "narrowing" is a silent
  data-loss path, and the u06 R8a refusal shows the failure mode is a hard
  refusal to start, not a warning.

**Size note.** `effects.ts` is 1373 lines / 60 KB — the largest non-test module
in the package and larger than `host.ts` + `record.ts` combined is not true
(host 41.9 KB + record 31.2 KB), but it is larger than either alone. It is the
single biggest shrink candidate and the one where the architecture's warning is
most directly applicable.

### 3.2 The double Goal/work driver — and the wiring gap this audit found

**Architecture requirement:** "stockGoal可保存目标；managed-work期间只有一个续行负责者，
使用公开disarm/交接；不让两个driver不断注入'继续'。"

#### 3.2.1 The handover exists and is correct — and now has a production caller

`WorkService.takeContinuation(root)` (`host.ts`) implements the handover exactly
as specified: it calls `goals.disarm(root)`, then reads the goal back and reports
`objectivePreserved`, `revisionUnchanged`, `phaseBefore`, `phaseAfter`,
`activationAfter` — observations a reader can check rather than trust.
`goal.test.ts` (7 cases) and `isolation.test.ts` exercise it.

**What the graph showed at the commit this audit started on (`42c2485`).**
`takeContinuation` had **zero production callers**. Its only callers were
`goal.test.ts` (7 sites) and `isolation.test.ts` (7 sites). Nothing in
`host-plugin.ts`, `tools.ts`, or the bundle patch called it. So the `disarm` was
implemented and tested, but on the composed profile **the Goal driver was never
actually disarmed by a run**, and the "exactly one continuation owner"
requirement was not satisfied at runtime.

**Why the tests could not see it, which is the point.** The tests call
`takeContinuation` **directly**. They therefore proved the *mechanism* — that
`disarm` is mild and preserves the durable objective — while the product still had
two drivers armed on one root. This is the same oracle/scenario mismatch as
`G-FIX-04` and as §3.2.2: a test that exercises a component in isolation cannot
observe whether the product calls it.

**What `982e82b` did about it.** The handover is now taken at `createRun`, the only
moment the exact live root `Agent` is in hand and before the run can accept any
work:

```
const continuation = this.takeContinuation(input.root)
```

and the **result is stored on the run record**, not merely logged: `record.ts`
gained an optional `continuation` field (`continuationHandoverSchema`) and
`initialRunRecord` writes it when present. The reasoning recorded in the code is
the one that matters for a reader: a run whose continuation was never handed over
is **indistinguishable** from one whose handover was recorded as "no goal present"
unless the outcome is on the record, and those are different facts about who
drives the root. Nothing fails the run when the goal service is absent — with no
Goal mounted there is nothing to contend with.

**What this does not establish.** As with the launch port, this is a **code path
plus a test-tier result, not a measured boot**. No gate report has been
regenerated and no `dsh --profile daily` boot has re-asserted the one-owner rule.
The next executable check is a boot that creates a run with a real Goal mounted
and asserts the record's `continuation` field reports `disarmed: true` with
`objectivePreserved` and `revisionUnchanged` true.

**Status of the finding:** closed at the code and test tier. It is recorded here
in both states rather than only the final one, because the sequence — a graph
audit finding the missing call, then a repair — is the evidence that the method
finds defects the test suite structurally cannot.

This is not a delete candidate. It was a missing call — **now made** — and §3.8
records it as one instance of a defect class this audit found three times.

#### 3.2.2 The launch port gap — FOUND BY THIS AUDIT, THEN REPAIRED AT `2d4534f`

This is the finding that justifies the graph method, so both states are recorded.

**At the snapshot where this audit started (`42c2485`):** `WorkService.setLaunchPort`
had **zero production callers** — `grep -rn "setLaunchPort"` over the whole
repository returned 19 hits, all in `src/*.test.ts`, plus the definition itself.
`createContinuableLaunchPort` was called from 8 test files and nowhere else.
`host-plugin.ts` constructed the service, registered the disposer and called
`open()` — and never installed a port.

**The consequence, quoted from the drain branch:** with no port installed, a
`submit` recorded the task, transitioned it to `unknown` with
`uncertainty: 'no launch port installed'`, and **launched nothing**. The N=10
concurrency result (C01 at T1) was therefore a result about the service with a
port that a **test** had installed — which is what a port seam is for, and the
tests say so — but the composed daily profile could not launch a single child.

**At the current snapshot (`2d4534f` + `b8f1ef2`):** the gap is closed, and the
regression test that should have caught it exists.

`WorkService.createRun` now calls `this.installDefaultLaunchPort(input.root)`
before any task can be admitted, and the method installs
`createContinuableLaunchPort({ subagents, parent: root, provider:
this.config.subagentProvider, maxDepth: this.config.maxDepth })`. The bundle
patch gained `subagentProvider: spawn` under the `daily-work-host` config row.
Three design choices in that repair are worth recording because they are the
correct ones:

- **It does not overwrite an installed port** (`if (this.launchPort !== undefined) return`),
  so a test's scripted port survives. The production port is a default, not an
  override — which is what keeps the seam testable.
- **It is bound at `createRun`**, where the exact live root `Agent` is in hand,
  rather than to a session-id string — authority follows the object, not an id
  that survives replacement.
- **It leaves the port unset when `ctx.subagents` is absent**, so the drain path
  reports `no launch port installed` rather than inventing the ability.

`production-port.test.ts` (`b8f1ef2`) then closes the oracle/scenario mismatch
that allowed the defect: it installs **no** port, lets the service bind the
production one, and asserts the drain reaches the real `startContinuable` seam
(`accepted: true`, reason is **not** `no launch port installed`, task not
quarantined as `unknown`). Its second case is the complement: with the subagent
runtime genuinely absent, the service must still report honestly. The provider
remains a scripted adapter, which the audit explicitly allows — what is under test
is the wire, not that a paid model produces good work.

**What this does NOT establish.** The wiring is a code path, and the regression
test that exercises it (`production-port.test.ts`) installs **nothing** and lets
the service bind the production port itself — which is the right oracle, and is
exactly the test whose absence let the defect survive. But the N=10 evidence in
`qualification/results/M3.2-N10-concurrency/` still predates the change, **no gate
report has been regenerated**, and no boot on the composed profile has been
re-run. So "the composed profile can now launch a child" is established at the
test tier, not yet at the boot tier. The next executable check is a `dsh --profile
daily` boot that calls `createRun` and asserts a non-null `launchPort` without any
test installing one.

### 3.3 Duplicate history CRUD — **NOT PRESENT**

**Architecture requirement:** "用SessionQuery替换任何重复history CRUD."

**What the graph shows.** No module in `packages/dsh-daily-work/src/` implements a
session-history store. `grep -rn "history"` over the non-test sources returns:

- `host.ts:815` — the word appears once, in a comment about budget ("the bill is
  history").
- `record.ts` — zero occurrences.

The package's only persistence is the `dsh_daily_work` run record (task
assignment, budget, outbox, tombstones) and, in the not-on-the-product-path
modules, `dsh_daily_effects`. **The `dsh_daily_work_refusals` domain named in
earlier revisions of this sentence has been DELETED** with its `RefusalLedger`
under F8 / REC-09 / REC-10 (§3.8.1); it was never opened by any product path, and
nothing was persisted under it. None of these stores session events.
`SessionQueryEngine` appears in the test tree only, mounted as a
dependency because `ctx.subagents.listChildren` needs it to read child Sessions
back (`concurrency.test.ts:132-135`, `isolation.test.ts:146-149`).

**Verdict: nothing to delete.** There is no duplicate history CRUD to replace.
The architecture's item is a design rule that the implementation already honours;
reporting it as a completed deletion would be inventing work. The corresponding
*forward* requirement — that history access be a host-authorized API and not a
kernel-reachable SQLite path — is unbuilt, because there is no kernel yet (§4).

### 3.4 The second model-facing execution surface — **NOT PRESENT as a module; PRESENT in the preset**

**Architecture requirement:** "模型主用pwsh/bash/cmd、terminal-first prerequisite、
把IPython放optional/lab" must leave the target daily configuration; shell must
leave the daily preset.

**What the graph shows.** This project adds **no** execution tool. It exports
`host`, `service`, `tools`, `web-search`, `tool-protocol-guards` — none registers
a shell or a terminal. (The `dsh-ipython` package added later exports an
`ipython` tool, which is an execution surface; §3.6 covers it.)

**What the preset shows.** The composed preset in use is now shipped **in the
repository** at `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`,
a copy of the shipped `standard` with **exactly two added rows**
(`daily-work-tools`, `ipython-tool`; verified by diff: 35 added lines, 0 removed).
An earlier revision of this section named
`D:\DSH\home\canary5\.agent-presets\daily-standard\agent.cordis.yml` — a **runtime**
directory, which is the deployment shape G-FIX-05 and G-FIX-12 record as a defect,
because no repository file reproduced it. It still contains the shipped shell rows
(`tool-bash` disabled on win32, `tool-pwsh` enabled) and the measured tool catalog
from a real Session is (`qualification/results/R9-delivery/surface-r9-verified-fresh-install.json`,
a fresh install with the probe adding no row):

```
28 tools: ask_user_question, create_goal, edit, exit_plan_mode, get_goal, glob,
          grep, interrupt_agent, ipython, job_kill, job_list, job_output,
          list_agents, present, pwsh, read, read_image, send_message, skill,
          subagent, subagent_fork, todo_write, update_goal, web_fetch,
          web_search, work, workflow, write
```

So `pwsh` **is** in the model's catalog today, **`ipython` now is too**, and there
is still no tool named `python_exec`. That is not a delete proposal against this
package — the shell rows belong to the stock preset — but it is the current state
the delivery documentation must describe, and the shell's presence is the
precondition the architecture says must be removed before promotion. (An earlier
revision of this section said "27 tools" from `M8.5-c2-real-boot/e2e-tool.json`,
which predates the `ipython` row; see §3.6's correction box.)

### 3.5 "Truncate-then-spill counted as complete retention" — **PRESENT upstream; not implemented here**

**Architecture requirement:** "用统一data capability替换'先截断再spill'…'副本摘要当原文'";
"`spillStore.saveText`只负责保存文本和返回opaque locator，不提供统一读取/删除/权限/引用计数契约；
保存的是已被裁剪的文本时，它不会变成'原始完整结果'。"

**What is true today.** The mechanism is real and shipped, and this project does
not wrap or replace it:

- `spill-local` writes to a **per-process temp root**:
  `privateRoot()` = `mkdtempSync(join(tmpdir(), 'dsh-spill-'))`
  (`packages/spill/spill-local/src/store.ts:36-38`). The shipped base bundle
  mounts `spill-local` with **no `root` config**
  (`packages/bundle/base/cordis.patch.yml:390-391`), so the temp-root default is
  what runs.
- The locator handed to the model is an **absolute filesystem path**
  (`locator: SpillLocator(saved.path)`, `spill-local/src/index.ts:156`), and the
  retrieval hint is verbatim
  `'Use read with offset/limit, or grep this path to search within it.'`
  (`spill-local/src/index.ts:159`).
- The trigger is `maxInlineBytes: 50000` (`base/cordis.patch.yml:393-396`), and
  the replacement is a bounded head/tail preview plus that path.

**So "the model reads a host spill path directly" is not a hypothesis — it is the
shipped, default behaviour, and the retrieval hint tells the model to do it.**
This is exactly the architecture's "模型自行读host spill path" item, and the
replacement ("统一data capability") does not exist in this repo.

**Verdict:** no module to delete (the behaviour lives upstream and is not
duplicated here), and **no unified data capability to replace it with** — see §4.
Recording it as done would be false.

### 3.6 The model-facing shell as the primary surface — **still true; the IPython package is now a real bundle**

**Architecture requirement:** `python_exec` is the model's regular execution
surface.

**What is on the composed profile.** The measured catalog from a real Session on
`daily-standard` is **28 agent-keyed tools including `pwsh`**, and **still no tool
named `python_exec`**. So the model's execution surface is the shell **and** the
new `ipython` tool together, and the preset still mounts the shipped shell rows.

> **Correction, and it matters for the architecture claim.** This section
> originally read "**27 tools including `pwsh`**" from
> `M8.5-c2-real-boot/e2e-tool.json`. That file is a real measurement of the tree it
> was taken on, but it predates the `ipython` tool row shipping, so it undercounts
> by exactly that tool. Current measurements, all 28:
> `M11-ipython/e2e-tool.json` (via a verification overlay that INSERTED the row),
> `M12-deliverable-surface/surface.json` (from the profile's own composition, no
> inserted row), and `R9-delivery/surface-r9-verified-fresh-install.json` (**a fresh install
> following `docs/DELIVERY.md` §2, booted from a foreign cwd, probe adding no
> row**). The architecture's requirement is unchanged and still unmet: the shell
> must *leave* the daily preset, and it has not.

**What has been built since this section was written.** The paragraph that stood
here said `packages/dsh-ipython/` was untracked work-in-progress with "no
`package.json`, no `lib/`, no `cordis.patch.yml`, no test file, and no export", and
that it "cannot be loaded by any profile". **All of that is now false and is
withdrawn.** The package is a real bundle:

| Component | State now |
|---|---|
| `package.json` | Present, with `dsh.bundle.patch: ./cordis.patch.yml` and five exports (`host`, `tool`, `kernel`, `plugin`, `protocol`) |
| `lib/` | Compiled, with `.js` + `.d.ts` for every export |
| `cordis.patch.yml` | Present; mounts `ipython-kernel-host` at HOST level with the interpreter path, broker script, output cap, cell timeout and interrupt grace as host policy |
| Preset row | Shipped in-repo at `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` as `ipython-tool` — ONE tool with ONE `code` parameter, no lifecycle tool |
| Tests | A passing suite (`src/*.test.ts`, 54/54 recorded in `M11-ipython/tests.txt`) |
| Reachability | Measured in a real boot: `ipythonToolPresent: true`, `ipythonIsOnlyParameter: true`, `forbiddenLifecycleTools: []` |

**This is the fourth instance of the §3.8 defect class, and it was fixed by the
same method.** The package's first version compiled and passed 38/39 tests while
being unloadable by any profile, because `package.json` declared no
`dsh.bundle.patch`. And the `ipython` gate's *first* PASS cited a verification
overlay that INSERTED the tool row — proving the tool works when a row is present,
not that the product carries one. Both are recorded as G-FIX-04 and G-FIX-12.

**What is still NOT finished, stated as plainly as the earlier paragraph did.**
There is no `python_exec` tool name. The shell has not left the preset. There is no
N control in a UI and no hard host-wide 30 (see §3.4 and §2.1). The 112-case spec
remains **112/112 `NOT_RUN`** — a tool appearing in a catalog is not a case
passing, and the `IPY-*` family's subject is kernel *behaviour*, not row wiring.

**Two measured findings the delivery docs must carry** (probe tier only — the
audit's own rule is that mechanism probes are not gate PASSes; all 112 new cases
remain `NOT_RUN`):

1. **The audit's first-choice transport is impossible on this platform.**
   `transport='ipc'` fails at socket creation with
   `ZMQError: Protocol not supported (addr='ipc://kernel-ipc-4')` — Windows libzmq
   is built without IPC support. The workable encrypted path is
   `transport_encryption='required'`, which yields a connection file carrying
   `curve_publickey`/`curve_secretkey` and **removes** the
   `Kernel is running over TCP without encryption` warning that the default path
   emits. Evidence: `qualification/results/M11-ipython/TRANSPORT-FINDINGS.md`,
   `mechanics.json`.
2. **Two distinct classes of cell do not settle after an interrupt.**
   Await-suspended: `settled: false` after 20.15 s, a second interrupt also `false`
   after a further 10.07 s, `process_alive_after: true`
   (`M11-ipython/cases.json`). Non-interruptible C code
   (`re.match(r'(a+)+$', …)`): `timedOut: true` after 12.16 s with the interrupt
   delivered in 0.002 s (`M5-lifecycle/PROBE-FACTS.md` fact 9). The CPU-loop case
   interrupts in 1.1–1.8 s, so this is specific to those states. Worse, fact 10
   measures the consequence: **the kernel is left with a pending interrupt that
   aborts the NEXT cell** (`status: 'aborted'`, `executionCount: null`, no
   output), and the cell after that runs normally. So "unknown but probably fine"
   is not a defensible post-grace state — continuing without a restart silently
   corrupts the next result. The required behaviour is **bounded grace → report
   `unknown` → restart the kernel**.
3. **A cell id is not an isolation boundary, measured.** Fact 16: a background
   thread left by cell `c-owner` mutated `shared['value']` and a later cell
   `c-victim` printed the mutation. The consequence recorded in
   `kernel-lifecycle.ts` is that a cell id is an attribution/cancel/audit key and
   no isolation is claimed — matching the architecture's own statement that
   "cell不是恶意代码之间的安全隔离边界".

### 3.7 Duplicate/dead abstractions found by the graph

Beyond the named candidates, the graph surfaced one class of dead weight that was
real and small. **All three items are now gone; the table is kept as the record of
what was proposed, with the outcome in the last column.**

| Item | Where | Evidence | Outcome |
|---|---|---|---|
| `probe-m7.test.ts` | `src/` | Header: "TEMPORARY probe: delete after M7 recon." 3 tests, imports `SqliteSessionQueryEngine`, `SystemPrompt` — recon scaffolding, not a gate. | **Deleted** (verified absent from the tree) |
| `spike.test.ts` | `src/` | 1 test, "drives a real token-meter projection". A spike. | **Deleted** (verified absent) |
| `sig-probe.mjs` | `packages/dsh-daily-work/` | `git status`: ` D packages/dsh-daily-work/sig-probe.mjs` | **Deleted** (still ` D` in the working tree) |

**The defect class is larger than the three instances below, and the fourth one is
the IPython package.** §3.6 records it: `packages/dsh-ipython` shipped with no
`dsh.bundle.patch`, so it compiled and passed its tests while being unloadable by
any profile — the same "mechanism proven, product never calls it" shape, this time
for a whole package rather than a function. It is fixed. The class is now four
instances, and the standing check in §3.8's closing paragraph is what finds them.

### 3.8 THE DEFECT CLASS: mechanisms that are proven but never called by the product

This is the most useful thing the import graph produced, so it is stated as a
class rather than as unrelated notes. **Four** separate mechanisms were found
**implemented, well-tested, and not reachable from any production path**:

| # | Mechanism | Found at | State | What it meant in the product |
|---|---|---|---|---|
| 1 | `launch-port.ts` / `setLaunchPort` | `42c2485` | **Fixed** — `2d4534f` + test `b8f1ef2` | A `submit` recorded a task, marked it `unknown` with `no launch port installed`, and launched nothing. The composed profile could not start a single child. |
| 2 | `takeContinuation` | `42c2485` | **Fixed** — `982e82b` | The Goal round-driver was never disarmed by a run, so **two continuation owners** could drive one root. |
| 3 | `recovery.ts` (`applyWorkerSettlement`) — the run `epoch` guard | verified at `982e82b`; **resolved at `6bfc810`** | **CLOSED BY DELETION** — `6bfc810` + `00421ec` (F8 / REC-09 / REC-10) | The guard was not wired and the field was not marked unused: the guard, its `WorkerSettlement` type, its `RefusalLedger` and the run record's `epoch` field were **deleted**, because the topology measurement showed the guard's input cannot be constructed on any production path. The v1 cases REC-09/REC-10 stay FAIL, and v2 records a NON-CLAIM. See §3.8.1. |
| 4 | `packages/dsh-ipython` — the whole package, with no `dsh.bundle.patch` | M11 | **Fixed** — bundle patch, `lib/`, preset row | The package compiled and passed 38/39 tests while no profile could load it; the model would never have seen an `ipython` tool. See §3.6. |

**Two more instances of the same shape are open and are NOT this class**, because
in each the mechanism is reachable but has no *consumer*: `ctx.dailyHistory` (the
M7 history plane is mounted and correct, and nothing in the product calls
`history(caller)`) and the run record's `continuation` field (written by
`createRun`, read by nothing). Both are recorded in `docs/GAPS.md`; a reachable
service with no caller is a different, weaker defect than an unreachable one, and
conflating them would overstate the finding.

**The shared shape, and why the tests could not see any of them.** In all three
cases the module had real regression tests that **passed**. They passed because
they call the mechanism *directly*, so they proved the mechanism while the product
never invoked it. This is the same failure class `G-FIX-04` recorded — *"a gate
whose oracle is weaker than its scenario will pass while the product is broken"* —
and it is structurally invisible to component tests. A port/seam that exists so a
component can be driven by a scripted adapter is exactly what makes the product's
own wiring unobservable to those tests.

**The check that finds it** is the one this audit used, and it is cheap:

1. take the `exports` roots from `package.json`;
2. close over intra-package relative imports;
3. list every non-test module **not** in that closure;
4. for each, grep for its callers outside `*.test.ts`.

Anything in step 3 whose only callers are tests is a candidate for this class.
**It should be run as a standing check**, because the three instances were found by
reading a graph, not by running a suite.

#### 3.8.1 The run `epoch` field WAS inert in the product — the third instance (CLOSED BY DELETION; the finding is preserved below as history)

> **RESOLVED, AND NOT BY THE ROUTE THIS SECTION RECOMMENDS.** The finding below is
> preserved as written (it is the audit's own record of how the defect was found),
> but its "Next executable repair action" is **superseded**. The repair taken was
> the *second* option this section already named — mark the field unused and drop
> the claim — except that it went further: **the guard, its `WorkerSettlement`
> type, its `RefusalLedger` over `dsh_daily_work_refusals`, and the `epoch` field
> itself were all DELETED** (`6bfc810`, corrected by `00421ec`). The reason is
> sharper than the unreachability recorded here: the topology measurement
> (`qualification/results/R9-recovery-topology/`) showed the guard's **input
> cannot be constructed on any production path**, because no production call site
> targets a terminal task state and the state the product actually leaves an
> unsettled task in — `unknown`, reservation held — has no production exit. So
> wiring `applyWorkerSettlement` would have meant inventing a settlement producer,
> which the audit forbids. **v2 does not claim the guarantee**, and the v1 cases
> REC-09/REC-10 stay FAIL. Read the rest of this section as history, not as a plan.

**The architecture's requirement.** `record.ts:410-414` documents `epoch` as
*"Monotonic run epoch. Bumped when a run is re-adopted by a new host generation. A
callback carrying a stale epoch must be rejected rather than silently accepted."*
**This comment no longer exists**: `record.ts:410-441` now records that there is
no `epoch` field and why it was removed.

**What actually exists.** The guard is real, and it is correct:

- `applyWorkerSettlement` (`recovery.ts:254`) compares the settlement's epoch to the
  record's current epoch and **refuses the authoritative write** when they differ
  (`recovery.ts:274-276`), leaving the task unmoved and its reservation held. It
  also writes the refusal to a **separate** domain (`dsh_daily_work_refusals`) so a
  diagnostic can never be mistaken for authority.
- It has real regression tests: `durability-records.test.ts` exercises the stale
  case, the mismatched case and the current case (three call sites).

**What the graph shows, verified at `982e82b`.** `recovery.ts` is **not reachable
from any production path**:

- `recovery.ts` has **zero non-test importers**. Its only importer is
  `durability-records.test.ts`.
- It is **not** in the closure of the five `package.json` `exports` roots
  (`host-plugin`, `host`, `tool-protocol-guards`, `tools`, `web-search-plugin`).
- `applyWorkerSettlement` has **zero callers** outside `recovery.ts` itself and the
  test file.

**Therefore: the epoch is inert in exactly the way the launch port was.**
`initialRunRecord` sets `epoch: 1` (`record.ts:468`) and, outside `recovery.ts`,
**no production code reads or writes it.** The only place the epoch is compared at
all is the unwired guard. So:

- The field's documented meaning ("bumped when a run is re-adopted by a new host
  generation") is not implemented anywhere: nothing bumps it.
- The enforcement it promises exists only in a module the product never calls.
- A stale callback carrying an old epoch therefore **cannot** be rejected on epoch
  grounds in the product, because the code path that would compare it is not on the
  product path.

**A correction to my own earlier claim.** An earlier revision of this audit, and of
`README.md`, said the epoch was enforced in `recovery.ts` "just not wired" and
treated the README's original "the record's `epoch` field is inert" sentence as
therefore **stale and removable**. **That was wrong and has been reverted.** The
guard's existence is not enforcement; reachability is. The original README sentence
was accurate, and the audit's own §3.2.1 finding about `takeContinuation` should
have made the reviewer suspicious of the same shape one module over.

`tool-protocol-guards.ts:61-67` states the position plainly and was right all
along: *"It does not make the run record's `epoch` field meaningful … no code reads
or writes it after `initialRunRecord` sets it to 1, so a caller cannot present a
stale epoch to be rejected. Object identity is the check that is mechanically
enforceable today; the epoch is an unused field."*

**What IS enforced today, stated so the gap is not overread.** Object identity is:
`tool-protocol-guards.ts` compares the calling Agent against the live registry
(`ctx.agents.get(id) === owner`), which is a real monotonic check for the
in-process resume case and is mounted at the host plane. So the *stale-owner*
problem is covered; the *stale-generation-across-a-process-boundary* problem is
not, and **v2 does not claim it** — the `epoch` field that was the vestigial
promise of it has been deleted rather than left in place.

**Next executable repair action (SUPERSEDED — see the note at the top of §3.8.1).**
This section recommended wiring `applyWorkerSettlement`, or else marking `epoch`
unused and keeping the guard as qualification-only. **Neither was taken.** The
resolution was the stronger form of the second option: the guard, its type, its
refusal ledger, its separate domain and the `epoch` field were all deleted
(`6bfc810`, `00421ec`), because the topology measurement showed the guard's input
cannot be constructed at all — there is no settlement producer to wire it to, and
the state the product leaves an unsettled task in has no production exit. The
replacement is a **NON-CLAIM**, not a control:
`qualification/results/R9-recovery-topology/` carries the graph, the
falsification control, and the measured `unknown`-has-no-exit probe.

**Status of the finding:** **CLOSED BY DELETION** (was OPEN). It was the third
instance of the class when recorded; the deletion is the project's decision that
the mechanism should not exist, which is a different outcome from wiring it. The
v1 cases REC-09/REC-10 remain FAIL as the historical record of what was asked for
and never delivered.

#### 3.8.2 Two more modules joined the not-reachable set

Re-running the graph at `982e82b` (25 non-test modules, 13 reachable) added two
modules that did not exist at `42c2485`:

| Module | Reachable | Non-test importers | Note |
|---|---|---|---|
| `perf-metrics.ts` | No | none | Zero importers of any kind, including tests. Not judged — in-flight. |
| `web-provenance.ts` | No | none | Zero importers of any kind, including tests. Not judged — in-flight. |

They are recorded rather than classified: they are mid-authoring, and a module with
no importer yet is not the same object as one whose callers were removed.

Also newly reachable at `982e82b`, and correctly so: `capacity.ts`
(`HARD_CHILD_CAPACITY = 30`, imported by `host.ts` and `target-setting.ts`) and
`target-setting.ts` (the UI-settable `targetActiveChildren` in [1, 30] over
`SettingsProvider.installSection`). Both are imported by `host.ts` and are on the
product path.

## 4. Inventory: what the OLD report claimed vs what is now true

### 4.1 The old report is an immutable snapshot and its numbers do not carry over

`qualification/gates.json` (104 cases, `schema_version: 1`, generated by
`qualification/runners/build-gates.py` against
`qualification/specs/gate-spec.json`) is **an audit snapshot, not a live claim**.
It is preserved unchanged. Three independent facts make its numbers
non-transferable:

1. **The new spec has no overlap with it.** `acceptance-spec.json`
   (`schema_version: 2`, 112 cases, ids `DEP-01…UPG-08`) and the old spec (104
   cases, ids `A01…J03`) share **zero** case ids. Verified by set intersection:
   empty. There is no mapping by which an old PASS becomes a new PASS.
2. **The old report's own generator says so.**
   `qualification/gates-summary.json`: `promotion_decision: "NOT_READY"`,
   `promotion_reason: "Mandatory gates remain NOT_RUN or BLOCKED_EXTERNAL. No
   daily promotion is claimed."`
3. **Its evidence hashes are NOT stale — an earlier version of this list claimed
   they were, and that claim is refuted.** It read: "Re-hashing all 127 evidence
   references in `gates.json` against disk: **124 match, 3 do not** — T05, T06 and
   T08 all cite `qualification/results/M9.2-terminal-advanced/FINDINGS.md`
   recorded as `1f1408e7…` while the file on disk hashes `615adaad…`." Re-running
   that exact check gives **127 references, 127 match, 0 missing, 0 stale**: all
   three rows record `615adaad87d29e3c…`, which is the file's current digest. The
   `1f1408e7…` value was the older one and the rows had already been regenerated
   (consistent with G-FIX-11's regeneration of `gates.json`). **The total is now
   `125` rather than `127`**, because the D10 re-judgement removed that row's two
   evidence references with its `PASS` (a non-PASS row carries no `evidence` key
   in this report's shape); the two paths are named inside D10's note. The
   retraction is recorded as **G-VER-05** in `docs/GAPS.md` rather than quietly
   deleted, because
   an unverified negative claim is worth as little as an unverified positive one —
   and this one had already been copied into `README.md` and `docs/DELIVERY.md`,
   where it is now also corrected.

**Current true counts, read from `qualification/gates.json` on disk** (re-read for
this delivery pass, not copied from an earlier revision; the deployment identity
those PASS rows carry is `ece4037a…`). **`D10` was re-judged from `PASS` to `FAIL`
in the S2 pass** — see the note under the table:

| Status | Count | Of which mandatory (`required_for: daily_ready`, 88 total) |
|---|---|---|
| PASS | 84 | 74 |
| NOT_RUN | 10 | 10 |
| FAIL | 3 | 3 |
| BLOCKED_EXTERNAL | 1 | 1 |
| NOT_APPLICABLE | 6 | 0 (all `required_for: conditional`) |
| **Total** | **104** | **88** |

**Why `D10` moved, and why it stays a FAIL rather than becoming a gap.** D10's
PASS note asserted that "a real guard now refuses a stale-generation settlement,
with diagnostic evidence going to a SEPARATE domain (`dsh_daily_work_refusals`)".
R9 then **deleted** that guard, its `RefusalLedger` and that domain (§3.8.1), and
the row was never re-judged — so it had been passing on a statement that was no
longer true. Its frozen oracle requires the authoritative write to be REFUSED and
the attempt RETAINED as diagnostic evidence; neither exists in the current tree.
`FAIL` is the honest value: the requirement is unmet and the absence is
*demonstrated*, which is the same discipline E01/E06 are held to. The v1 cases
`REC-09`/`REC-10` already read FAIL for the same mechanism, so this also makes the
two reports agree. `gates-summary.json` was updated in step so the two files
cannot disagree.

The 10 `offline_qualified` gates are all PASS; the 6 `conditional` gates are all
`NOT_APPLICABLE`. The 14 non-PASS mandatory gates are `A12`, `C01`, `D10`, `E01`,
`E02`, `E06`, `E12`, `R01`, `U01`, `U02`, `U03`, `U04`, `U05`, `U06`; each one's
reason is tabulated in `docs/DELIVERY.md` §9, and the verdict basis is restated in
`qualification/results/R9-delivery/CLAIM-CHECK.md`.

### 4.2 PASSes the new architecture makes obsolete

These are PASSes in `gates.json` that the new architecture reclassifies. They are
**not** claimed as regressions — the code they measure is real and its tests pass.
They are claims whose *subject* the new architecture removes or demotes, so they
must not be counted toward the new target.

| Gate | Old status | Why the new architecture makes it obsolete |
|---|---|---|
| **T01–T10** (all 10) | PASS | The whole M6 terminal block. Its subject is the **native PTY as the model's execution surface**, which is precisely what the new architecture removes: "shell/cmd/pwsh不是模型主要执行面". T02's own stimulus is "经模型工具打开shell并发送IPython" — sending Python into a shell. The new spec replaces this family with **IPY-01…IPY-08** (real ipykernel, persistent variables, top-level await, no stdin, message correlation, cancel-and-reuse, activation end) and **BRG-01…BRG-08** (the programmatic call scope). No T gate survives as a mandatory new gate. |
| **J01, J02, J03** | NOT_APPLICABLE | Their note says it plainly: "Conditional capability not enabled. No dedicated kernel is implemented; the native terminal was qualified instead." The new architecture makes the dedicated kernel **mandatory**, so these three become live obligations (the new spec covers the same ground in IPY-06, IPY-07 and BRG-06/BRG-07). |
| **E09** (opaque shell) | PASS | A PASS about a shell-command classifier being a refusal device rather than a control. It stays true, but its subject leaves the model's surface. |
| **R01** | NOT_RUN (PARTIAL) | Retrieval through the ported search provider is still real work, but the new architecture's data plane (DAT-01…DAT-08, WEB-01…WEB-08) asks for layered coverage and capture, which R01 does not cover. |
| **A08** (stock baseline) | PASS | Its subject — "全部差异可归因；未删除stock组件后仍称stock" — is a claim about the C0/C2 diff. It remains true for the current composition, but the new architecture requires the daily preset to *stop* mounting the model-facing shell, so the baseline itself changes. |

**Everything else in the old report** (A01–A12, B01–B10, C02–C18, D01–D14, E01–E12,
F01–F08, R02–R08, U01–U06, W01–W03) measures this package's own mechanisms —
admission, budget, durability, the acceptance runner, the tool protocol, the guard.
Those subjects survive the architecture change, so those PASSes remain meaningful
**for the old spec** and are the best available evidence that the mechanisms work.
They are not new-spec PASSes and must not be reported as progress toward them.

## 5. In-flight modules (classified, not judged)

At `2d4534f`, `src/` contains five untracked modules and two untracked test files
from another agent, plus a new untracked package. They have **no production
importer yet**, and classifying a module mid-authoring would misreport it, so they
are listed with their importers and no verdict:

| Module | Lines | Test importers | What it is |
|---|---|---|---|
| `kernel-lifecycle.ts` | 2201 | none | Kernel lifecycle, backpressure, permissions, recovery semantics. Its header cites 17 measured facts from `qualification/results/M5-lifecycle/PROBE-FACTS.md`. |
| `artifacts.ts` | 1648 | `data-plane.test.ts` | The artifact data plane: capture, page, byte-range, reconcilable commit order. Header states it is not a second object store. |
| `history-plane.ts` | 1249 | none | Authorized history access, source-linked memory, projection manifest, on top of `ctx.sessionQuery`. |
| `worktree-isolation.ts` | 1030 | `verification-gates.test.ts` | Writer isolation and root integration authority. Header states a worktree is not a security boundary. |
| `observations.ts` | 428 | `data-plane.test.ts` | The `ObservationDescriptor` zod schema with a host-authored `authority` field, gap vocabulary and a `GrantTable`. |
| `probe-m7.test.ts` | — | — | Header: "TEMPORARY probe: delete after M7 recon." Recon scaffolding. |
| `spike.test.ts` | — | — | One test, "drives a real token-meter projection". A spike. |

Two of the new test files are substantive rather than scaffolding and their
describe blocks map directly onto new-spec gate families:
`data-plane.test.ts` covers **DAT-01…DAT-08** plus an observation-authority case,
and `verification-gates.test.ts` covers **VER-01…VER-08**. They are evidence in
progress, not gate results: **`gates.json` has not been regenerated against them**
and no new-spec case has moved off `NOT_RUN`.

**Several of these modules have since left this table by reaching production, and
two of the rows above are simply gone.** Re-run at the current tree
(`qualification/results/R3-unwired/import-graph.txt`: 78 `src/` files, 31
non-test, **25 reachable / 6 unreachable**):

- Now **REACHABLE** (they were in-flight here): `artifacts.ts` and `observations.ts`
  via the `data-host`/`data-service` exports; `history-plane.ts` and
  `web-provenance.ts` via the `history` export; `worktree-isolation.ts` and
  `verify.ts` via the `writers` export. Each has a production importer, not just a
  test — which is the distinction this table could not make while they were being
  written.
- Still **UNREACHABLE**: `durability-runner.ts`, `effects.ts`,
  `kernel-lifecycle.ts`, `perf-metrics.ts`, `reconcile.ts`, `recovery.ts`.
- **`probe-m7.test.ts` and `spike.test.ts` no longer exist** — see §3.7.
- **`packages/dsh-ipython/` is now a real package** — see §3.6, which replaces the
  "three source files and no `package.json`" line that used to end this section.

## 5b. What this project DELETED or REPLACED from the stock composition

This is the delete audit proper, and it is separate from §2–§3: those classify
**this project's own modules**, while this section inventories every difference the
delivery actually makes to the **stock** composition. The authoritative sources are
the three patch files, read here rather than summarised from prose:

| Patch | Active rows |
|---|---|
| `profiles/daily-candidate/cordis.patch.yml` | `subagent` (config override), `agent-presets` (config override) |
| `packages/dsh-daily-work/cordis.patch.yml` | `subagent` (config override), then `insert`: `daily-work-host`, `daily-web-search`, `daily-history`, `daily-work-tool-protocol-guards`, `daily-writers`, `daily-data-plane`, `daily-programmatic-scope` |
| `packages/dsh-ipython/cordis.patch.yml` | `insert`: `ipython-kernel-host` |
| `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` | a full copy of the shipped `standard` preset **plus** exactly two rows: `daily-work-tools`, `ipython-tool` |

**Deleted: nothing. Replaced: nothing. Disabled: one stock row, deliberately.**
That is the finding, and it is checkable in one command per file. The single
`disabled:` change is `tool-pwsh`, turned off unconditionally so that IPython is
the model's only execution surface; it is named and justified in the first bullet
below rather than left to be discovered.

- **No row is removed.** The patch dialect has no delete verb — `vendor/include/src/index.ts:77-100`
  destructures `{ id, insert, name, ...overrides }` and applies overrides; an
  `insert` pushes into `target.config` or `data`. There is no operation that drops
  an entry, so a patch **cannot** delete a stock row even if one wanted to. Every
  "removal" in this project is therefore either (a) an override that leaves the row
  mounted, or (b) a `disabled: true` that leaves the row present and inert.
- **`disabled:` over the patch files: zero. Over the preset: ONE, and it is this
  project's.** `grep -n disabled` over both profile patches and the package patch
  returns **zero hits**. The preset copy is a different story, and an earlier
  revision of this section got it wrong — it listed `tool-pwsh` as "Changed here?
  No", which was true when written and false after commit `35c829d`. The table
  below is re-read from the files rather than carried forward:

  | Row | Shipped condition | In this project's copy | Changed here? |
  |---|---|---|---|
  | `tool-bash` | `!!js process.platform === 'win32'` (off on Windows) | identical | No |
  | `tool-pwsh` | `!!js process.platform !== 'win32'` (ON on Windows) | `disabled: true` | **YES** |
  | `tool-subagent-codex` | `disabled: true` | identical | No |
  | `tool-subagent-claude-code` | `disabled: true` | identical | No |
  | `tool-ralph` | `disabled: true` | identical | No |
  | `tool-plugin-manager` | `disabled: true` | identical | No |

  **The `tool-pwsh` change is a real behavioural change and it is deliberate.**
  The shipped expression leaves the PowerShell tool ON on Windows. This project
  turns it OFF unconditionally, so that IPython is the model's only execution
  surface. That is the architecture the trusted-local deployment claims, and it is
  measured: the composed profile's tool catalog contains 27 tools and does not
  contain `pwsh` (`qualification/results/M12-deliverable-surface/
  surface-fresh-install.json`), while `ipython` is present with the single
  parameter `code`. **A reader looking for "what did this project change" must not
  miss this row** — it is the one place the delivery narrows the stock tool
  surface, and the earlier "No" in this table would have hidden it.

  **The diff is no longer "35 added, 0 removed".** That figure was true when the
  preset was a pure addition. Re-measured, it is **176 added and 5 removed**, and
  the removals are worth naming individually because "5 removed" overstates the
  behavioural change: **four are comment lines** and **one is the shipped
  `disabled:` expression** above.

  | Removed line | What it is |
  |---|---|
  | 4 lines of the shipped comment block explaining that both shell tools consume the host registry | comment only, no behaviour |
  | `disabled: !!js process.platform !== 'win32'` | **the one behavioural removal** — replaced by `disabled: true` |

  Re-run the diff rather than trusting either number:

  ```sh
  diff /d/DSH/src/dsh-src/packages/preset/agent-presets/presets/standard/agent.cordis.yml \
       /d/DSH/work/dsh-native-daily/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml
  ```
- **Two rows are REPLACED-IN-PLACE rather than deleted**, and both are config
  overrides of a still-mounted stock row:
  1. **`subagent`** — the stock row is mounted with **no `config` block**, so
     `maxActiveSubagents` falls back to the schema default 8 and `maxDepth` to 1.
     Both patches restate it as `maxActiveSubagents: 10` / `maxDepth: 1`. The row
     itself is not replaced; its config is. (Restating both keys is required
     because a patch replaces the whole `config` object — DELIVERY §4, Trap 6.)
  2. **`agent-presets`** — the stock roster is given a deployment-added `roots`
     entry and `default: daily-standard` in place of the stock `standard`. This is
     the row that was **cwd-relative and therefore broken** for two revisions
     (G-FIX-12, G-FIX-13); it is now
     `!!js new URL('presets/', ctx.baseUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')`.
     `includeShippedRoot` and `includeUserRoot` are restated at their defaults
     because a patch replaces the whole `config` object — so **the shipped root is
     still included**, which is why `standard`, `ptc`, `minimal` and `cordis` are
     all still listed alongside `daily-standard`.
- **One thing WAS deleted, in the repository rather than in the composition:**
  the duplicate `daily-work-host` insert. The profile patch and the package's own
  bundle patch both declared it, so installing the package as a bundle would have
  registered the service twice. The bundle is now the sole owner and the profile
  patch's `insert:` list is gone entirely — the two remaining occurrences of the
  word are comment lines explaining why it is gone. Recorded as part of
  G-FIX-12.
- **One file was deleted from the working tree:** `packages/dsh-daily-work/sig-probe.mjs`
  (`git status` records ` D`). It was a signal probe, and `M9.9-signal/` carries
  the findings it produced.
- **Scaffolding this audit proposed for deletion is already gone**, which is a
  correction to §3.7: `probe-m7.test.ts`, `spike.test.ts` and the
  `ipython-preset-row.yml` fragment **no longer exist** in the tree. §3.7 and §5
  still list them as present; treat those two tables as snapshots at `2d4534f` and
  this list as current.

**Justification for the two overrides.** `subagent`'s default of 8 is a measured
capability gap: N=10 is not satisfiable by any stock profile, and the resolved
graph shows the override taking effect (`M0.5-c0-resolved-graph/`). `agent-presets`
is not a capability change at all — it is what makes the two agent-scoped tool rows
reachable, and without it a profile boots with a kernel service and no way to call
it. Neither removes a stock component, and neither is claimed as stock: the
`C0`/`C2` diff exists precisely so these two rows are attributable.

## 6. What this audit does not establish

- **It does not establish that anything should be deleted.** Every proposal above
  is a proposal. The one module that satisfies the mechanical delete test
  (`durability-runner.ts`) is recommended for **relocation**, not removal,
  because it produces cited evidence.
- **It does not measure coverage.** No coverage tool was run. "Test coverage" in
  this document means "which test files import the module", which is a
  reachability fact, not a line-coverage number. Any statement of the form "X% of
  this module is covered" would be **UNVERIFIED** here.
- **It is a snapshot, not a standing claim.** The tree advanced three commits
  during the audit and one finding was repaired in flight (§3.2.2). Any reader
  more than a few commits past `2d4534f` should re-run the graph rather than
  trust the tables; the method is four lines of Python over
  `from './x.ts'` specifiers plus a closure from the `exports` roots.
- **It does not resolve the two biggest questions.** Whether `verify.ts` and
  `reconcile.ts` become product paths or stay qualification-only is a product
  decision, and the import graph cannot make it. Likewise whether
  `takeContinuation` gets a production caller (§3.2.1).
