# R3 — the unwired-capability scan: the real import graph, and what it found

**Date:** 2026-09-20
**Package:** `packages/dsh-daily-work`
**Method:** the standing check in `docs/GAPS.md` §"The defect class this project kept
producing", applied literally — build the graph from `package.json`'s `exports`
roots, follow imports transitively, and ask of every module whether any
**non-test** importer reaches it.

**Artifacts in this directory**

| File | What it is |
|---|---|
| `import-graph.mjs` / `.txt` | The module-level reachability scan. Parses specifiers with the TypeScript compiler's own preprocessor, not a regex. |
| `export-scan.mjs` / `.txt` | The export-level scan: for every exported **value**, is there a product-tier caller? |
| `verify-unwired.mjs` + `../runners/verify-unwired.patch.yml` | The boot probe that exercises the product path through the real profile resolver. |
| `profile-boot.json` / `.txt` | The probe's measured output. |
| `dump-config.yml` | `--dump-config` for the composed profile, used to settle a service-ordering question the probe raised. |
| `tsc-build.txt` / `tsc-check.txt` | Both required type-check gates, empty because both exited 0. |

**Commands**

```sh
# the scan
node qualification/results/R3-unwired/import-graph.mjs
node qualification/results/R3-unwired/export-scan.mjs

# the boot probe (from D:/DSH/src/dsh-src, DSH_HOME=D:/DSH/home/canary12)
node apps/cli/lib/bin.js --profile daily-candidate \
  --patch D:/DSH/work/dsh-native-daily/qualification/runners/verify-unwired.patch.yml --no-open
# boot_exit=124 is the TIMEOUT killing the long-lived web host, NOT a boot failure.
# The verdict is the VERIFY-UNWIRED line, written before the timeout.

# the gates
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # exit 0
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json      # exit 0
```

---

## 1. The measurement error that had to be fixed first

The first version of `import-graph.mjs` used a regex over `from './x.ts'` and
reported **12** unreachable modules. That was wrong, and the way it was wrong
matters more than the number.

A multi-line import does not match a single-line pattern:

```ts
import {
  installDailyWorkTargetSetting,
  type TargetSettingHandle,
} from './target-setting.ts'
```

The regex reported `artifacts`, `observations`, `capacity`, `target-setting`,
`reconcile` and `programmatic-scope` as unreachable — every one of which has a
real non-test importer. It also produced a **false positive**: a test containing
the literal text `from './kernel-lifecycle.ts'` inside a string was counted as an
importer.

The scan now asks the TypeScript compiler for the specifier list
(`ts.preProcessFile`, which parses rather than pattern-matches) and the module
count moved from 12 unreachable to **6**. The lesson is the one this project keeps
re-learning in a new medium: **the first oracle was weaker than the claim**, and a
green scan built on it would have sent three agents to "wire" modules that were
already wired.

---

## 2. The reachability table

**Exports roots** (the product's entry points, from `package.json`):

```
./data-host            -> src/data-plugin.ts
./data-service         -> src/data-service.ts
./history              -> src/history-plugin.ts
./host                 -> src/host-plugin.ts
./programmatic-scope   -> src/programmatic-scope-plugin.ts
./service              -> src/host.ts
./tool-protocol-guards -> src/tool-protocol-guards.ts
./tools                -> src/tools.ts
./web-search           -> src/web-search-plugin.ts
./writers              -> src/writers-plugin.ts
```

**Reachable (25 non-test modules).** "via" is the export subpath whose transitive
closure contains the module; "non-test importers" excludes every `*.test.ts`.

| Module | via | non-test importers |
|---|---|---|
| `host-plugin.ts` | `./host` | *(is an entry root)* |
| `host.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host-plugin.ts`, `launch-port.ts`, `tools.ts` |
| `record.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts`, `counting.ts` |
| `states.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts`, `counting.ts`, `record.ts` |
| `counting.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts` |
| `capacity.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts`, `target-setting.ts` |
| `target-setting.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts` |
| `homelock.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts` |
| `launch-port.ts` | `./host`, `./service`, `./tools`, `./tool-protocol-guards` | `host.ts` |
| `tools.ts` | `./tools`, `./tool-protocol-guards` | `tool-protocol-guards.ts` |
| `tool-protocol-guards.ts` | `./tool-protocol-guards` | *(is an entry root)* |
| `web-search-plugin.ts` | `./web-search` | *(is an entry root)* |
| `web-search.ts` | `./web-search` | `web-search-plugin.ts` |
| `data-plugin.ts` | `./data-host` | *(is an entry root)* |
| `data-service.ts` | `./data-host`, `./data-service` | `data-plugin.ts` |
| `artifacts.ts` | `./data-host`, `./data-service` | `data-service.ts` |
| `observations.ts` | `./data-host`, `./data-service` | `data-service.ts`, `artifacts.ts` |
| `history-plugin.ts` | `./history` | *(is an entry root)* |
| `history-plane.ts` | `./history` | `history-plugin.ts` |
| `web-provenance.ts` | `./history` | `history-plugin.ts` |
| `programmatic-scope-plugin.ts` | `./programmatic-scope` | *(is an entry root)* |
| `programmatic-scope.ts` | `./programmatic-scope` | `programmatic-scope-plugin.ts` |
| `writers-plugin.ts` | `./writers` | *(is an entry root)* |
| `worktree-isolation.ts` | `./writers` | `writers-plugin.ts` |
| `verify.ts` | `./writers` | `writers-plugin.ts` (**type-only**), `worktree-isolation.ts` |

**Unreachable (6 non-test modules) — the work queue.**

| Module | non-test importers | direct test importers |
|---|---|---|
| `durability-runner.ts` | (NONE) | (NONE) |
| `effects.ts` | (NONE) | `effects.test.ts` |
| `kernel-lifecycle.ts` | (NONE) | `kernel-recovery.test.ts` |
| `perf-metrics.ts` | (NONE) | `eco.test.ts` |
| `reconcile.ts` | (NONE) | `durability-advanced`, `durability-records`, `lifecycle`, `reconcile`, `tool-protocol`, `wire-faults` |
| `recovery.ts` | (NONE) | `durability-records.test.ts` |

**One reachable module is reachable for the wrong reason.** `verify.ts` is reached
only because `worktree-isolation.ts` imports two *digest helpers*
(`acceptanceDefinitionDigest`, `digestInputs`) from it. Its actual product-facing
entry point — `runAcceptance` — has **no product-tier caller**: the only callers
anywhere are `real-tasks.test.ts` and `qualification/runners/acceptance.mjs`. So a
module-level reachability check reports `verify.ts` as fine while the acceptance
runner it exists to provide is a qualification-time tool, not a product surface.
This is the same defect one level down, and the module-level graph is
structurally blind to it. §4 records it.

---

## 3. What I wired, and how it was proved through the product

**Nothing was wired, and the reason is not that nothing needed it.**

`target-setting.ts` is the mechanism behind the user's live N. It IS reachable
(`host.ts` imports it; `host-plugin.ts` calls `installTargetSetting(ctx)`), so it
was not on the work queue. But reachability is a statement about the **import
graph**, and the recorded defect class is a statement about the **call graph**:
`setLaunchPort` and `takeContinuation` were both reachable too — their modules
were imported — while nothing called them. `target-setting.test.ts` mounts a
settings provider and calls `installDailyWorkTargetSetting` **directly**, so it
could not see whether the composed profile reaches the section.

So the product path was **measured** rather than assumed, by a boot probe under
`qualification/runners/`, and the answer is that it works:

```json
{"profileName":"unknown","servicePresent":true,"targetBefore":10,
 "settingsPresent":true,"namespaceRegistered":true,"namespaceWaitMs":28,
 "namespacesSeen":["agent-default-model","agent-loop","agent-presets","daily-work",
   "llm-deepseek","llm-pi-ai","locale","permission","shell","subagent",
   "subagent-model-selection","ui-chat","ui-conversation","ui-onboarding",
   "ui-theme","web-search-deepseek"],
 "namespaceRevision":0,"namespaceValue":{"targetActiveChildren":10},
 "targetSettingHandlePresent":true,"writeAttempted":true,"writeOk":true,
 "writeReason":null,"targetAfterWrite":11,"liveReaderObserved":true,
 "restoreOk":true,
 "restoreNote":"wrote the original resolved value back; the daily-work section remains as an explicit user layer resolving to the same number",
 "error":null}
```

Read precisely, that establishes four things at the **boot tier** rather than the
test tier:

1. `ctx.dailyWork` is live in a real composed `daily-candidate` boot, and
   `targetActiveChildren()` returns the composition value (10).
2. The `daily-work` namespace IS registered in the deployment's real settings
   provider — it appears in `describe()`, among 16 namespaces, and no other
   module in this package registers a namespace.
3. A write through `settings.update(ns, patch, expectedRevision)` — the same
   public API an authenticated UI would use — is **read back** by the service's
   own `targetActiveChildren()`, which returned 11. That is the live-reader
   property `host.ts` claims in prose ("a UI change takes effect without a
   restart"), measured instead of asserted.
4. The probe restored the original value and reported the residual honestly.

**Two measurement errors of my own are recorded rather than smoothed over.**

- **The probe reported a false absence on its first run.** With
  `inject = ['dailyWork']` it read `ctx.get('settings') === undefined` and
  reported "the daily-work namespace has no provider". The resolved tree shows
  `settings` is row 58 and `daily-work-host` is row **580**, so the probe had
  activated on the earlier edge and measured its own race — the same class
  `docs/GAPS.md` G-FIX-09 records. `inject` is a **readiness gate**; a probe that
  reads a service must declare it. Adding `settings` to `inject` is what makes
  the result a statement about the product.
- **Even with both injected, the namespace appeared 28 ms late.** The probe now
  polls with a bounded budget and **records the wait** (`namespaceWaitMs: 28`),
  because a non-zero wait is itself evidence that `installSection`'s registration
  is edge-ordered. A single immediate read would have measured fiber notification
  order, not the product.

**The probe also had to be made non-destructive.** The write persists to
`$DSH_HOME/settings.yaml`, so the first successful run left
`targetActiveChildren: 11` in the deployment it had just measured — the next run
would have observed its own residue. The probe now writes the original resolved
value back, reports `restoreOk`, and states in `restoreNote` what it cannot undo:
the `daily-work` section remains as an explicit user layer resolving to the same
number. The file was removed after the final run, and the deployment is back to
its pre-probe state (no `settings.yaml`).

**`package.json` and `cordis.patch.yml` were NOT touched.** No `exports` entry and
no patch row was added, because no new capability was wired. There is nothing to
reconcile against other agents' edits.

---

## 4. What I deliberately did not wire, and why

### 4.1 `reconcile.ts` — the product needs the DECISIONS, but has no evidence source, and wiring one would invent it

**The mechanism is complete and correct.** `reconcileTask` decides the true state
of a task from evidence across the five positions (durable intent → child
accepted → inbox claimed → request entered → effect confirmed), and its rule is
the right one: every branch that cannot PROVE a safe conclusion returns `unknown`,
holding the slot and its reservation.

**Why it is not wired, stated as the reason rather than as a preference.** Its
input is a `ChildEvidence` record, and every field of it is an **observation**
(`sessionExists`, `agentLive`, `requestObserved`, `turnOutcome`, `resultRef`). The
product has no code that gathers one:

- `grep -rn "ChildEvidence" src/` excluding tests returns the interface
  definition, `durability-runner.ts`, and nothing else.
- `durability-runner.ts` — the one non-test caller — is itself unreachable, and it
  does not gather evidence either: it hard-codes `sessionExists: false,
  agentLive: false, requestObserved: false` for every task and comments that this
  is the honest evidence "in this runner there is no live child".
- The services a real gatherer would read (`ctx.agents.get`, `ctx.subagents.
  listChildren`, `ctx.sessionQuery.observeSession`) are reached from no non-test
  module in this package.

So wiring `reconcile.ts` means first **building the evidence-gathering path**, and
that path does not exist. The recorded conclusion for `recovery.ts` (G-SEAM-21)
applies here in exactly the same form and I am adopting it rather than working
around it: *"that path does not exist yet, so wiring one would invent a caller
rather than connect a real one."*

**What is honest to say about it:** `reconcile.ts` is **product-shaped but
unreachable**, and it is the decision half of a two-part mechanism whose other
half (evidence gathering) is unbuilt. `docs/DELETE-AUDIT.md` §2.4 already classes
it INVESTIGATE for this reason. I am recording it as **UNCLEAR — blocked on a
missing evidence path**, not as "no product role", because the decisions it makes
are exactly the ones the gates D03–D09 describe.

### 4.2 `effects.ts` — the product does not need the framework as written

`effects.ts` has **zero importers of any kind inside the package** except its own
test. The evidence for "no product role" is specific rather than a count:

- `EffectAdapter` (`effects.ts:273`) is an interface with **zero implementations**
  outside `effects.test.ts`.
- `EffectLedger` (`effects.ts:440`) has zero production constructions.
- `classifyShellCommand` / `mayRunAutomatically` / `CLASSIFIER_LIMITS` have zero
  callers outside the test file — and `M9.5-effects` measured the classifier being
  defeated four ways, with its own note calling it "a refusal device, not a
  control".
- `runEffectProgram` / `resumeEffectProgram` have no caller outside the test file.

**But it is not deletable, and that is why I did not touch it.** The domain
`dsh_daily_effects` is a real persisted object (`EFFECT_SCHEMA_VERSION = 1`), and
`M9.20-real-tasks/u06-rollback.json` measured what a schema mismatch does: the
domain facility **refuses to open at all** —
`DomainError: domain 'dsh_daily_effects': stored record 'eff_…' in table
'operations' does not match its schema`. Removing the schema without a migration
makes a store that contains effect records unopenable.

So the classification is: **no product role for the framework; the schema is
retained for read compatibility.** That split is `docs/DELETE-AUDIT.md` §3.1's
proposal, and narrowing it is a change to a persisted domain that I did not make
and that no gate here depends on. The `u06-rollback.mjs` rehearsal imports it by
absolute path, which makes it a real (qualification-tier) caller.

### 4.3 `durability-runner.ts` — a CLI harness, not a library, and its removal is a relocation

Zero importers, no `exports` entry, not referenced by `cordis.patch.yml`, by
`profiles/`, or by any runner. Its only consumer is the documented command in
`docs/OPERATIONS.md:142`:

```
node --import tsx src/durability-runner.ts parent <storeDir> <reportPath>
```

Its output (`qualification/results/M4.1-process-kill/report-final.json`) is the
evidence behind gates D03–D09. So it is **not** a product capability and it is
**not** dead: it is a qualification harness that happens to live in `src/`.
`docs/DELETE-AUDIT.md` §2.3 proposes relocating it to `qualification/runners/`,
where the other standalone executables live, rather than deleting it. **That is a
file move outside my ownership, so I am reporting it and not doing it.**

### 4.4 `kernel-lifecycle.ts` and `perf-metrics.ts` — another agent's in-flight work

Neither has any non-test importer. `kernel-lifecycle.ts` is reached only by
`kernel-recovery.test.ts`; `perf-metrics.ts` only by `eco.test.ts`. Both are
substantial modules (`kernel-lifecycle.ts` ~99 KB, `perf-metrics.ts` ~43 KB) whose
own test files are active in this tree right now, and `docs/DELETE-AUDIT.md`
already classifies this set as **IN-FLIGHT** with no keep/delete verdict:
"classifying a module mid-authoring would misreport it."

I am recording them as **IN-FLIGHT — not triaged**, which is a different statement
from "no product role" and is the honest one.

### 4.5 `verify.ts` — reachable, but its product-facing entry point is not

Recorded in §2 and repeated here because it is a finding rather than a note.
`runAcceptance` / `runAcceptanceWithBudget` / `refCas` / `serializeReceipt` have
**no product-tier caller**; the only callers are `real-tasks.test.ts` and
`qualification/runners/acceptance.mjs`. `writers-plugin.ts` imports from
`verify.ts` in a **type-only** position (`import type { AcceptanceDefinition,
AcceptanceReceipt }`), which erases at runtime, so the writers service does not
call into it either. The acceptance runner is a **qualification-time tool**, not a
product surface. `docs/DELETE-AUDIT.md` §2.4 names exactly this question and
declines to settle it; I am recording the measurement, not a verdict.

---

## 5. A second-order finding: reachable modules whose CAPABILITY is unreachable

The module-level graph asks "does anything import this FILE". A file can be
imported for one helper while its product-facing entry point has no caller, so
`export-scan.mjs` asks the same question one level down, per exported **value**.

**The scan's first version was too noisy to be evidence** — 307 of 481 exports
"unwired" — because it counted `interface` and `type` declarations, which have no
runtime existence and are consumed in type positions a textual search cannot
distinguish from a same-named local. Excluding types (221 of them, 127
unreferenced) leaves **260 value exports, 150 with no product-tier caller**. That
number is still large, and most of it is expected: a module exports a coherent
vocabulary, and the product calls a subset. It is a **map, not a defect list**.

The entries that matter are ones where the unwired export is the module's whole
reason to exist. Three are worth naming:

| Export | Module | Why it matters |
|---|---|---|
| `runAcceptance` | `verify.ts` | The acceptance runner. Only callers are a test and a qualification runner. §4.5. |
| `relaunchPrepared` | `recovery.ts` | Gate D03's fix. `recovery.ts` has no non-test importer, so it is unreachable. |
| `KernelSupervisor` | `kernel-lifecycle.ts` | In-flight work; not triaged. |

### 5.1 The finding I did not expect: the settlement half of the task lifecycle has no production caller

This is the same defect class, one level down from the module graph, and it is
the one I would put in front of the project first.

`production-port.test.ts` proved the product **launches**: with no test-installed
port, `drain` reaches the real `ctx.subagents.startContinuable` and the task moves
`prepared → launching → accepted`. `launch-port.ts` is explicit that this is
admission and **not** execution:

> "A resolved `startContinuable` is ADMISSION. It is not execution, and it is
> certainly not completion."

The measurement is what happens after that edge. Every call to
`WorkService.transition` in non-test source is inside `runDrain`:

```
host.ts:1323  to: 'launching'
host.ts:1332  to: 'unknown'      (no launch port)
host.ts:1354  to: 'unknown'      (launch failed)
host.ts:1372  to: 'accepted'
```

plus `recovery.ts` — which has no non-test importer. So the states the **product**
can produce are `launching`, `accepted` and `unknown`. Nothing produces
`executing`, `settling`, `confirmed` or `cancelled`. Correspondingly:

- `observe()` and `setReadyTasks()` — the only producers of the liveness the
  counts read — have **no caller outside tests**.
- `recordSpend()` / `spendRoot()` likewise.

**The consequence, measured through the product path.** I added a product-path case
to `reconcile.test.ts` (a file I own) that installs **nothing** and drives the real
production stack — real AgentLoop, real SubagentRuntime, real spawn provider, the
service's own production launch port. It asserts the launch really happened
(`accepted: true`), then reports what the product itself left on the record:

```
task 't1' state          = 'accepted'    (and stays there)
budget.reserved          = 1             (never released)
counts.activeAssignments = 0             (while a real child is running)
counts.quarantinedUnknown= 0             (not the unknown branch)
counts.confirmed         = 0
counts.cancelled         = 0
after `finish` (beginClosing): phase='closing', task still 'accepted', reserved still 1
```

`accepted` is a slot-holding state (`states.ts:56-64`), and only
`confirmed`/`cancelled` release a reservation (`host.ts:900`). Neither is reachable
from a non-test caller. So **a launched child's slot and reservation are never
released by the product path**, and the model's own `status` action reports
`activeAssignments: 0` while a real child is running, because that counter requires
`executing` plus observed liveness and nothing can produce either.

The test asserts these as the **current** values, so it is a regression test for
whoever wires the settlement path: it will fail loudly when the gap closes.

**What this does NOT prove:** that a child produced a result.
`startContinuable` resolves at the inbox-acceptance edge and no live provider is
authorized (`live_provider_budget_authorized: false`), so the child does not run to
completion here. The claim is narrower and is the finding: **the product has no
code path that would record a result if it did.**

**Is this the same finding as G-SEAM-21?** No, and the distinction matters.
G-SEAM-21 is that `applyWorkerSettlement`'s **epoch guard** is unreachable, so a
stale generation's settlement is not refused. This is that **no settlement arrives
at all** — the path the epoch guard would sit on does not exist. Wiring
`applyWorkerSettlement` would not close it, because the missing piece is upstream
of the guard: something has to receive a child's outcome. They are the two halves
of one missing subsystem, and G-SEAM-21's own text says so ("call
`applyWorkerSettlement` from whatever path receives a worker settlement — that
path does not exist yet").

---

## 6. G-SEAM-21 re-run: the finding still holds

The task asked only for a re-scan, and the re-scan reproduces the recorded state
exactly:

```
UNREACHABLE  src/recovery.ts
   non-test importers: (NONE)
   direct test importers: src/durability-records.test.ts
```

- `recovery.ts` has no non-test importer. Confirmed.
- `applyWorkerSettlement` has no caller outside `recovery.ts` and
  `durability-records.test.ts`. Confirmed:
  `grep -rn applyWorkerSettlement` returns the definition, its internal uses, and
  that one test file.
- Nothing outside `recovery.ts` reads or writes `.epoch` after
  `initialRunRecord` sets it to 1. Confirmed: the only non-test hits are
  `record.ts:439` (the schema), `record.ts:493` (the initialiser), and
  `recovery.ts` itself.

**I did not attempt to fix it**, per the task and because the recorded conclusion
is correct: the path that would receive a worker settlement does not exist, so
calling `applyWorkerSettlement` from anywhere today would invent a caller rather
than connect a real one. §5.1 is the measurement of what that missing path costs.

---

## 7. What is NOT proven

- **The boot probe proves the settings seam, not a UI.** This package registers
  **no Remote surface** (`grep -rn "TypertRemote" src/` outside tests returns
  nothing). The probe writes through `settings.update`, which is the API an
  authenticated UI would use, so it measures the **host half**. Whether a UI
  control exists and is wired to this namespace is a property of whatever client
  the deployment mounts, and it was not measured.
- **`profileName` is `"unknown"` in the probe output.** `ctx.get('profileContext')`
  did not resolve at probe time. This is cosmetic for the finding — every other
  field is from the service and the settings provider directly — but it is not a
  value I verified, so it is recorded as unknown rather than removed.
- **The boot probe ran with `boot_exit=124`.** That is the timeout killing a
  long-lived web host, not a boot failure, and it is the same reading
  `qualification/results/M4-data/profile-boot.txt` records for the same reason.
  The verdict is the `VERIFY-UNWIRED` line, which is written before the timeout,
  and the absence of any "startup failed" text. **I did not assert the absence of
  that text programmatically**, so a boot that failed for an unrelated reason
  after writing the line would not have been caught by this probe.
- **The probe's write is a real mutation of a real `DSH_HOME`.** It restores the
  value and reports the residual, and I removed the residual file afterwards
  (`D:/DSH/home/canary12/settings.yaml` did not exist before the probe and does
  not exist now). But the probe is not idempotent in the strict sense: run against
  a home that already had a `daily-work` section, it would overwrite that user's
  value with the value it read first. That is the correct restore semantics and it
  is still a write to a deployment.
- **`effects.ts`'s read-compatibility claim is taken from `M9.20`'s record, not
  re-measured here.** I did not open a store containing a v1 effect record. The
  citation is `qualification/results/M9.20-real-tasks/u06-rollback.json`, and the
  narrowing `DELETE-AUDIT.md` proposes is explicitly owed a read-compat test
  first.
- **`kernel-lifecycle.ts` and `perf-metrics.ts` are not triaged.** They are
  IN-FLIGHT work by other agents, and I made no keep/delete judgement about them.
- **The export scan's "no product-tier caller" is a textual lower bound.** A name
  that appears only in a comment counts as a caller, so a module reported as
  *wired* may still be unwired. A module reported as **unwired** genuinely has no
  textual occurrence outside tests — the stronger and more useful direction, and
  the one every finding above relies on. Names shorter than 4 characters are
  flagged `[weak]` in the output for the same reason.
- **I did not run the whole suite** (other agents are running tests in this tree),
  and no gate report was regenerated. The two required `tsc` gates exit 0; my
  in-scope test files (`reconcile.test.ts`, `states.test.ts`,
  `target-setting.test.ts`) pass, 72 tests, exit 0.
- **A concurrent agent committed my in-progress scan files.** Commit `1e0b8d6`
  ("R10 security re-derivation") swept `qualification/results/R3-unwired/` into
  itself at 03:21, while `import-graph.mjs` was still being revised. I made no
  commit and ran no `git add`. The consequence is that the `import-graph.mjs`
  **inside that commit is the buggy regex version**, not the parser-based one
  currently on disk. Anyone reading the commit's copy of the scan will get the
  wrong answer (12 unreachable instead of 6). The on-disk file is correct and its
  output is `import-graph.txt` in this directory.

---

## 8. Rows I want added to `docs/GAPS.md`

I did not edit `docs/GAPS.md` (another agent owns it). These are the exact rows:

```markdown
| G-SEAM-24 | **The settlement half of the task lifecycle has NO production caller, so a launched child's slot and reservation are never released.** | OPEN — blocks any claim that a run converges | Every call to `WorkService.transition` in non-test source is inside `runDrain` (`host.ts:1323` launching, `:1332`/`:1354` unknown, `:1372` accepted) plus `recovery.ts`, which has no non-test importer. So the states the PRODUCT can produce are `launching`, `accepted`, `unknown` — nothing produces `executing`, `settling`, `confirmed` or `cancelled`. `observe()` and `setReadyTasks()`, the only producers of the liveness the counts read, have NO caller outside tests; `recordSpend()`/`spendRoot()` likewise. MEASURED through the product path, not read from source: `reconcile.test.ts` §"PRODUCT PATH" installs nothing, drives the real AgentLoop + SubagentRuntime + spawn provider + the service's own production launch port, asserts the launch really happened, then records that the task sits at `accepted` with `budget.reserved: 1` forever, that the model's own `status` action reports `activeAssignments: 0` while a real child is running, and that `finish` moves only the RUN phase (`closing`) and leaves the task's slot held. `accepted` is slot-holding (`states.ts:56-64`) and only `confirmed`/`cancelled` release (`host.ts:900`). DISTINCT FROM G-SEAM-21: that is the epoch guard on a settlement being unreachable; this is that no settlement arrives at all. They are two halves of one missing subsystem — the same one G-SEAM-21 names ("that path does not exist yet"). Fix: build the child-outcome path (observe the child's Session or subscribe to `subagent/end`) and settle through it; the assertions in `reconcile.test.ts` are written as current-value measurements so they fail loudly when it is wired. |
| G-SEAM-25 | **`reconcile.ts` is product-shaped but unreachable, and its missing half is the evidence GATHERER, not a caller.** | OPEN — blocked on an unbuilt path | `reconcileTask` decides the true state of a task from `ChildEvidence` across the five positions, and its rule is right: anything that cannot be PROVEN safe returns `unknown` holding its slot. It is not wired because nothing in the product gathers its input: `grep -rn ChildEvidence src/` excluding tests returns the interface definition and `durability-runner.ts`, and that runner is itself unreachable AND hard-codes `sessionExists: false, agentLive: false, requestObserved: false` for every task (its own comment: "in this runner there is no live child"). The services a real gatherer would read (`ctx.agents.get`, `ctx.subagents.listChildren`, `ctx.sessionQuery.observeSession`) are reached from no non-test module here. Wiring `reconcile.ts` today would therefore invent a caller rather than connect a real one — the same conclusion G-SEAM-21 records for `recovery.ts`. Classed UNCLEAR-BLOCKED, not "no product role": the decisions it makes are exactly what gates D03–D09 describe. |
| G-SEAM-26 | **`verify.ts` is REACHABLE, but its product-facing entry point is not — `runAcceptance` has no product-tier caller.** | OPEN — the module-level import graph cannot see this | `verify.ts` appears reachable because `worktree-isolation.ts` imports two digest helpers from it (`acceptanceDefinitionDigest`, `digestInputs`). But `runAcceptance`, `runAcceptanceWithBudget`, `refCas` and `serializeReceipt` have NO product-tier caller: the only callers are `real-tasks.test.ts` and `qualification/runners/acceptance.mjs`. `writers-plugin.ts` imports from `verify.ts` in a TYPE-ONLY position (`import type { AcceptanceDefinition, AcceptanceReceipt }`), which erases at runtime. So the acceptance runner is a qualification-time tool, not a product surface — which is what `docs/DELETE-AUDIT.md` §2.4 records as INVESTIGATE without settling. Found by scanning at EXPORT granularity rather than module granularity: a module-level reachability check reports this file as fine. |
| G-SEAM-27 | **The first version of the R3 import-graph scan used a regex and reported 12 unreachable modules; the correct answer is 6.** | RESOLVED — measurement error, corrected | The regex over `from './x.ts'` does not match a multi-line `import {\n  a,\n  b,\n} from './x.ts'`, so it reported `artifacts`, `observations`, `capacity`, `target-setting`, `reconcile` and `programmatic-scope` as unreachable — every one of which has a real non-test importer — and it produced a false positive from a test containing the literal text `from './kernel-lifecycle.ts'` inside a string. Corrected by asking the TypeScript compiler for the specifier list (`ts.preProcessFile`, which parses rather than pattern-matches). Lesson, in the medium of tooling rather than gates: an oracle weaker than its claim passes while the answer is wrong. Evidence: `qualification/results/R3-unwired/import-graph.mjs`. |
| G-FIX-13 | **The `daily-work` live target setting IS reachable through the composed profile, and was previously proven only at the test tier.** | RESOLVED — measured on a real boot | `target-setting.ts` is on the product path (`host.ts` imports it, `host-plugin.ts` calls `installTargetSetting(ctx)`), so it was never on the unreachable list — but reachability is a statement about the IMPORT graph while the recorded defect class is about the CALL graph (`setLaunchPort` and `takeContinuation` were both reachable and both uncalled). `target-setting.test.ts` mounts a settings provider and calls `installDailyWorkTargetSetting` DIRECTLY, so it could not see the composed profile. MEASURED on a real `daily-candidate` boot through the real profile resolver (`qualification/runners/verify-unwired.mjs` + `.patch.yml`): `ctx.dailyWork` is live, the `daily-work` namespace IS registered in the deployment's settings provider (one of 16 namespaces in `describe()`), and a write through `settings.update(ns, patch, expectedRevision)` — the API an authenticated UI would use — is READ BACK by the service's own `targetActiveChildren()` (10 -> 11), which is the live-reader property `host.ts` claims in prose. The probe restores the value and reports the residual. TWO probe errors are recorded rather than smoothed over: `inject = ['dailyWork']` alone made the probe activate on the work service's edge and read `ctx.settings` as ABSENT — a false absence derived from the probe's own race (`settings` is row 58 of the resolved tree, `daily-work-host` is row 580); and even with both injected the namespace appeared 28 ms late, so the probe now polls and records `namespaceWaitMs`. `inject` is a readiness gate (G-FIX-09). NOT PROVEN: no UI control was measured — this package registers no Remote surface, so the probe measures the host half. |
```

---

## 9. Files I created or edited

| Path | Change |
|---|---|
| `qualification/results/R3-unwired/import-graph.mjs` | Created. Module-level reachability scan, parser-based. |
| `qualification/results/R3-unwired/import-graph.txt` | Created. Its output. |
| `qualification/results/R3-unwired/export-scan.mjs` | Created. Export-level scan, value exports only. |
| `qualification/results/R3-unwired/export-scan.txt` | Created. Its output. |
| `qualification/results/R3-unwired/FINDINGS.md` | Created. This file. |
| `qualification/results/R3-unwired/profile-boot.json` / `.txt` | Created. The probe's measured output. |
| `qualification/results/R3-unwired/dump-config.yml` | Created. Resolved config, used to settle the settings-ordering question. |
| `qualification/results/R3-unwired/tsc-build.txt` / `tsc-check.txt` | Created. Both empty; both gates exit 0. |
| `qualification/runners/verify-unwired.mjs` | Created. The boot probe. |
| `qualification/runners/verify-unwired.patch.yml` | Created. Its overlay. |
| `packages/dsh-daily-work/src/reconcile.test.ts` | Edited. Added the `PRODUCT PATH` describe; the existing 17 cases are unchanged. |

**Not touched:** `package.json`, `cordis.patch.yml`, `docs/GAPS.md`, `host.ts`,
`record.ts`, `recovery.ts`, and every other file outside my ownership list. No
commit, no push, no `git add`.
