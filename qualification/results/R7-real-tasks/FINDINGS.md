# R7 — the six M8 "real task" gates (U01–U06), honest status

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Repo:** `D:\DSH\work\dsh-native-daily` @ branch `ipython-native`
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` — verified by
`git rev-parse HEAD` in this session; **not modified**.
**Launcher:** `node /d/DSH/src/dsh-src/apps/cli/lib/bin.js` (built artifact, sha256 `69c49c871735dc7e…`)

This report establishes the honest status of the six gates that were recorded
`NOT_RUN` in `qualification/gates.json`. It was written after a previous agent died on
an infrastructure error before producing any output, so nothing here is inherited:
every claim below is either **executed in this session** with the command and exit
code recorded, or marked **BLOCKED_EXTERNAL** with the exact reason.

---

## 1. The six-gate table

| Gate | Name | Status | Maximum honest offline claim | Exact blocked remainder |
|---|---|---|---|---|
| **U01** | coding 闭环 | **PARTIAL — `OFFLINE_MECHANICS_PROVEN`** | The loop closes on a **real multi-file bug** in real sources judged by a **real vitest run** of an acceptance **frozen by sha256 before the patch exists**; the oracle discriminates (buggy tree fails, fixed tree passes) and a patch that edits the acceptance is detected by the digest. | **BLOCKED_EXTERNAL** — no model turn was run. The "patch" is a scripted edit, so the gate's stimulus ("a multi-file bug or build fix") was not produced by a model. See §4. |
| **U02** | research 闭环 | **PARTIAL — `OFFLINE_MECHANICS_PROVEN`** | A conflicting-source audit whose every conclusion is bound to a **quoted line at a pinned revision**, spot-checked **mechanically** against the real checkout; the dispute is present (A5) and the negative control proves the spot-check has teeth. | **BLOCKED_EXTERNAL** — the audit was not performed by a model and no web search ran. `disputed` status was authored by hand, not derived. See §5. |
| **U03** | 连续日用负载 | **PASS (controlled-input load)** | Six waves of top-up with pause/resume interleaved through the **real continuable stack**: resources flat (drift ≤1), listeners exactly flat (drift 0), cost exact (4/cycle, 24 total), no state pollution across two runs in one process. | **BLOCKED_EXTERNAL** — the model route is a **scripted adapter**, so "cost" is this project's reservation arithmetic, not a provider invoice; no real latency, no Web host. See §6. |
| **U04** | 配对比较 | **PARTIAL — statistical half PASS, live half BLOCKED_EXTERNAL** | The **statistical half is offline-runnable and was run**: three control groups composed as real presets differing by **exactly one row per step**, the tool catalog read from the real registry, three axes reported separately, and **no winner declared** with the reason computed (n=1 ⇒ no variance estimate). | **BLOCKED_EXTERNAL** — the **live half**. All three groups ran on one **scripted** adapter, so `completionQuality` is a constant by construction and the cost series is identical (1 call / 4 tokens each). No quality comparison was made. See §7. |
| **U05** | 独立 canary | **PASS (procedure + real upgrade executed)** | A canary procedure that **does not write the daily home** was executed, and a **real artifact upgrade through the real `dsh plugin` install path** against a real `DSH_HOME`: the composed tree was measured moving `budgetCeiling` 200 → 250, the new artifact **really booted with the extension loaded**, and the home was seeded from real state with **no credential copied**. | **BLOCKED_EXTERNAL** — no newer DSH/Node/plugin release is installable. The staged "new" artifact differs in **version string and patch config only**; its `lib/` payload is byte-identical (`libIdentical: true`). See §8. |
| **U06** | 回退 | **PASS (real rollback executed)** | A real rollback: the old artifact reinstalled through the real install path, the **cold pre-upgrade consistency snapshot restored byte-for-byte** (verified across directories), the old artifact **booting against the restored state**, and the external effect **reconciled from the world without re-sending** (transport invocations 1 → 1) and **still present** in the world, read by a **separate process**. | **BLOCKED_EXTERNAL** — the "remote" is a durable **file on this machine**, not a network service. Its durability across processes is real; its remoteness is not. See §9. |

### The headline honest statement

**Two of six gates (U05, U06) now close on real executed machinery. Four (U01–U04)
close only on their mechanical/statistical halves; the model-facing half of every one
of them is `BLOCKED_EXTERNAL` under `compatibility.lock.json` →
`runtime_authorization.live_provider_budget_authorized: false`.**

No gate is reported PASS on the strength of a stubbed model. Where a scripted
adapter was used, the artifact's own `kind` field says so
(`CONTROLLED_FIXTURE_COMPARISON_NOT_A_BENCHMARK`) and the test name states the
substrate.

---

## 2. What was executed vs only reasoned about

**Executed in this session (command + exit code):**

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `vitest run src/u01-coding-loop.test.ts src/u02-research-loop.test.ts src/u03-sustained-load.test.ts src/u04-paired-comparison.test.ts src/real-tasks.test.ts` | **0** | 5 files, **21 tests passed** |
| 2 | `node qualification/results/M9.20-real-tasks/u05-canary.mjs` (report redirected to R7) | **0** | 8 PASS / 0 FAIL / 2 BLOCKED_EXTERNAL |
| 3 | `node qualification/results/R7-real-tasks/canary-rollback.mjs` | **0** | **19 PASS / 0 FAIL** / 3 BLOCKED_EXTERNAL |
| 4 | `node qualification/results/R7-real-tasks/probe-u06-refusal-cause.mjs` | **0** | prediction held; corrects a recorded U06 claim |
| 5 | `tsc -p tsconfig.json --noEmit` (cwd = package) | **0** | clean |
| 6 | `tsc -p tsconfig.check.json` (cwd = package) | **0** | clean |
| 7 | one-file-fix probe against U01's own acceptance (staged outside the repo, removed after) | 1 | one-file fix **does** fail the acceptance; mechanism differs from U01's header — §4 |

**Only reasoned about, NOT executed (and therefore not claimed):**
- Any live model turn (U01, U02, U04, and the live half of U03/U05/U06).
- A real upgrade to a newer DSH release.
- Reconciliation against a real network remote.
- Any web search (U02's live half).
- The full test suite (deliberately not run — other agents are in this tree).

**Executed but with a fixture named up front:** the two scripted adapters
(`CompletingAdapter` in U03, `ScriptedAdapter` in U04) and
`packages/dsh-daily-work/m914-mock-llm.ts` for the U05/U06 boots.

---

## 3. The blocker, stated in the lock's own terms

Every `BLOCKED_EXTERNAL` above traces to the same field. Quoting
`compatibility.lock.json` verbatim:

```json
"runtime_authorization": {
  "scope": "LOCAL_IMPLEMENTATION_ONLY",
  "live_provider_budget_authorized": false,
  "budget_amount": null,
  "currency": null,
  "deadline": null,
  "restart_resume_authorized": false,
  "external_publication_authorized": false,
  "secrets": "Never put key values in this file; record safe source labels only."
}
```

**The exact field and value:**
`compatibility.lock.json` → `runtime_authorization.live_provider_budget_authorized: false`.

**What specifically cannot be done because of it:**

1. **U01** — the model cannot author the patch. The gate's stimulus is "a multi-file
   bug or build fix"; the fixture supplies the fix as a scripted edit, so what is
   proven is that the *acceptance machinery* discriminates, not that a model can find
   and fix a bug.
2. **U02** — the model cannot perform the audit and no search provider can be
   called. The audit is a hand-authored data structure; its `disputed` finding was
   written by hand.
3. **U03** — no real model latency or token cost exists, so "cost" is this project's
   own reservation arithmetic.
4. **U04** — this is the whole point of the gate. `completionQuality` cannot vary
   when the model is a constant, so **the comparison the gate asks for cannot be
   made at all**; only the statistical scaffolding and the group-composition diff can.
5. **U05** — no model version can be exercised, so a provider-side change cannot be
   validated.
6. **U06** — no live effect can be produced, so the reconciled effect is a local
   durable file.

**What a reader would need to authorize to unblock it.** The lock expresses
authorization as three fields that are all currently `null`, so unblocking means
filling them in:

- `runtime_authorization.live_provider_budget_authorized: false` → **`true`**;
- `runtime_authorization.budget_amount: null` → **a numeric ceiling** (this is the
  field the run would cost against; it is not currently expressible);
- `runtime_authorization.currency: null` → **a currency code**;
- `runtime_authorization.deadline: null` → **an ISO timestamp**;
- and `runtime_authorization.scope` would have to widen from
  `LOCAL_IMPLEMENTATION_ONLY`.

Because `budget_amount`, `currency` and `deadline` are `null`, **the lock cannot
currently express a cost at all** — there is no amount to spend against and no
currency to spend it in. That is a stronger statement than "no key is present": a key
being present on this machine does not create the authorization, and it does not
create the budget fields either. This was not bypassed: **no provider was contacted
and no budget was consumed in this session.**

---

## 4. U01 — coding 闭环

### What the file actually exercises

`src/u01-coding-loop.test.ts` (372 lines, 3 tests, all pass). It stages a temp
candidate tree from the **real** `src/states.ts` + `src/counting.ts` + `src/record.ts`,
injects a real bug into `holdsSlot` (returns `true` for the terminal states
`confirmed`/`cancelled`), and runs a **real vitest** acceptance written against the
correct behaviour:

1. baseline (unpatched real source) must **pass** — guards against a fixture that
   measures itself;
2. buggy tree must **fail**, and the failure must name `holdsSlot` /
   `capacityDeficit` rather than an unrelated crash;
3. after the fix the acceptance must **pass** again;
4. the acceptance's sha256 must be **unchanged** throughout.

Test 2 proves the freeze has teeth by weakening the acceptance and showing the digest
moves. Test 3 asserts against the real sources that `holdsSlot` is consumed by both
`counting.ts` and `host.ts`.

**Verdict: the mechanics are real and the oracle discriminates.** This is a genuine
frozen-acceptance loop. It is *not* a coding closure, because no model wrote the fix.

### A measured correction to the file's own header

The header claims:

> "A one-file fix in `counting.ts` would leave `admit` refusing a re-run of a
> confirmed task, which the acceptance catches."

I tested this rather than accepting it. Staging the bug and then applying a
**one-file fix that bypasses `holdsSlot` inside `counting.ts`** (so `countRun` agrees
with the correct behaviour while `states.ts` stays buggy) makes the acceptance fail —
**but not through `admit`**. The two failing assertions are both direct `holdsSlot`
assertions:

```
× INV-C1: holdsSlot agrees with the state machine > a terminal state does NOT hold a slot
× INV-C1: holdsSlot agrees with the state machine > every slot-holding state holds, and no other state does
```

and the five assertions that do exercise `countRun`/`mayAdmit` **all pass**:

```
✓ a finished run recovers its capacity > N confirmed tasks leave the full target free again
✓ a finished run recovers its capacity > N cancelled tasks leave the full target free again
✓ a finished run recovers its capacity > work still in flight DOES hold its slot
✓ the admission gate agrees with the count > a replacement is admitted once the target is free again
✓ the admission gate agrees with the count > a full target refuses the next admission
```

The acceptance never imports `host.ts` and never calls `admit`. So the acceptance
catches a one-file fix because it **tests `holdsSlot` directly**, not because it
catches the second consumer. The "multi-file" framing is overstated by one step: the
blast radius genuinely spans two files (verified statically by test 3), but the
acceptance does not demonstrate it.

**This does not make U01 a failure** — the oracle still discriminates, which is what
the gate needs. It is recorded because the header states a mechanism the code does not
implement, and this project has a recorded history of exactly that defect
(`G-FIX-04`: an oracle weaker than its scenario).

### Maximum offline claim

> Against the **real** `states.ts`/`counting.ts`/`record.ts`, an acceptance frozen by
> sha256 before the patch exists **fails on the buggy tree and passes on the fixed
> tree**, and an acceptance edited instead of the code is **detected**. Proven by a
> real vitest run.

### Blocked remainder

The model turn. See §3 items 1.

---

## 5. U02 — research 闭环

### What the file actually exercises

`src/u02-research-loop.test.ts` (360 lines, 5 tests, all pass). It holds a hand-authored
audit of DSH's Windows sandbox boundary with five findings, each carrying citations
`{source, revision, line, quote}`, a falsification condition
(`wouldBeOverturnedBy`) and explicit `unknowns`. The spot-check re-reads each cited
file **from the real pinned checkout** and asserts the quoted text is present
**verbatim on the cited line**. Two negative controls are present: a plausible-but-wrong
quote is detected, and an out-of-range line number is detected.

The pinned revision was verified in this session: `git rev-parse HEAD` in
`D:\DSH\src\dsh-src` returns `ddefc45fbc7f8e46dd73185e68295696d1297887`, matching
`PINNED_COMMIT` in the test.

**Verdict: the citation machinery is real and has teeth.** The artifact shape the
gate asks for — reviewable evidence, disputes, unknowns — is present and checked.

### Maximum offline claim

> A conflicting-source audit whose every conclusion is bound to a **quoted line at a
> pinned revision**, verified mechanically against the real checkout, with the dispute
> preserved rather than smoothed away, and with negative controls proving the
> spot-check can fail.

### Blocked remainder

- **No model performed the audit.** The findings are a literal in the test file.
- **No web search ran.** The live-search half is `BLOCKED_EXTERNAL`.
- The `disputed` status of finding A5 was **authored by hand**, not derived by a
  model weighing sources.

A reader should treat this as "the audit *format* and the citation *check* are proven",
not "a research loop closed".

---

## 6. U03 — 连续日用负载

### What the file actually exercises

`src/u03-sustained-load.test.ts` (468 lines, 4 tests, all pass, ~950 ms). It boots the
**production** stack — `@deepseek-ai/dsh-agent-loop`, the real `ctx.subagents`
continuable machinery, the real in-process spawn provider, a real durable JSONL Session
per child, the real storage domain — and drives six cycles of a 4-child wave through
the real `startContinuable` seam, moving every task through the real admission state
machine and interleaving pause/resume.

The model route is `CompletingAdapter`, a **scripted adapter** — a provider boundary,
not a second loop. The file's own header says so and explains why a gated adapter was
rejected (it measured `[4,0,0,0,0,0]`, holding the resource under test so its release
could not be measured).

### The measured range (regenerated by this session's run)

From `qualification/results/M9.20-real-tasks/u03-load.json`:

```
target 4, cycles 6, modelRequests 48
resourceTrend {first:5, last:6, min:5, max:6, largestStep:1, drift:1}
listenerTrend {first:14, last:14, min:14, max:14, largestStep:0, drift:0}
spent series  [4, 8, 12, 16, 20, 24]
admitted/cycle [4, 4, 4, 4, 4, 4]
```

- **No persistent resource leak:** the resource series drifts by **+1** over six
  cycles with a largest single step of 1; listeners are **exactly flat** (drift 0).
  The assertion is on the **trend**, not an endpoint, and the control arm runs first so
  the one-time mount cost is charged to the control (G-FIX-08's lesson).
- **No cost disappearance:** `spent` advances by exactly `TARGET` (4) every cycle and
  ends at exactly 24; `unknownReserved` and `overage` are 0.
- **No state pollution:** a second run in the same process starts empty and does not
  alter the first.

### Maximum offline claim

> A **controlled-input load test**: six waves of rolling top-up with pause/resume
> interleaved, driven through the real production services, showing no per-cycle
> resource trend, exact cost accounting, and run-keyed state isolation. **The load is
> driven by a controlled local route (the in-tree scripted adapter), not a live
> provider.**

### Blocked remainder and honest limits

- **No live provider**: cost is this project's reservation arithmetic, not a provider
  invoice. No real latency exists.
- **No Web host was run**, so host-level sockets and watchers are not covered.
- **The load is modest by design** (one vitest process, no recursive subagents). A
  six-cycle series **bounds** a leak over the range run; it does **not** exclude a slow
  one. This is stated in the artifact's own `notExercised` list.
- The gate's stimulus says "a long Session". Six cycles of a 4-child wave is **not a
  long session**; it is the longest run that respects the CPU discipline this
  environment requires. The gate's "sustained" is therefore **not** fully met.

---

## 7. U04 — 配对比较

### Which half is which

The gate has two halves and they must be reported separately.

**The statistical half is offline-runnable, and it was run.** `src/u04-paired-comparison.test.ts`
(502 lines, 3 tests, all pass). It composes C0/C1/C2 as **real preset directories**
mounted through the real `@deepseek-ai/dsh-agent-presets` roster, so the groups differ
by exactly the rows the plan names and by nothing else — verified as a **prefix chain**
(`c1.startsWith(c0)`, `c2.startsWith(c1)`) with **exactly one added row id per step**:

```
rowIds(c0) = ['base-tool']
rowIds(c1) = ['base-tool', 'agent-instructions']
rowIds(c2) = ['base-tool', 'agent-instructions', 'daily-work-tools']
```

The tool catalog is read from the real registry with the **agent object** as scope key
(passing `agent.ctx` collapses to the global layer and reports zero tools — the false
negative M8.5 records), and the three axes are reported **separately** with no combined
figure. The measured structure:

| group | toolCount | tools | hasWorkTool |
|---|---|---|---|
| C0 | 1 | `base_read` | false |
| C1 | 2 | `base_read`, `repo_instructions` | false |
| C2 | 3 | `base_read`, `repo_instructions`, `work` | **true** |

**No winner is declared**, and the reason is computed rather than asserted: with
`observationsPerGroup: 1` there is no within-group variance, so the standard error of a
difference is undefined. The artifact carries
`kind: "CONTROLLED_FIXTURE_COMPARISON_NOT_A_BENCHMARK"` and
`statistics.winnerDeclared: false`.

**The live half is `BLOCKED_EXTERNAL`.** All three groups ran on one **shared
`ScriptedAdapter`** instance — which is what makes it a *paired* comparison and is also
what makes the quality axis a constant:

```
completionQuality: "scripted: one text answer, no tool call"   (identical for C0, C1, C2)
cost: C0 = 1 call / 4 tokens; C1 = 1 call / 4 tokens; C2 = 1 call / 4 tokens
```

The cost series is **identical across groups by construction**. That is the honest
result of a controlled fixture, not a finding about the compositions. The file's own
`notClaimed` list says so: "that any control group produces better work: the model is
scripted, so quality is a constant".

### Maximum offline claim

> The **statistical and structural scaffolding** is proven: the three groups differ by
> exactly one explainable row per step, the tool catalogs are real and distinct, the
> three axes are reported separately, and **no winner is declared** with the reason
> computed from n=1.

### Blocked remainder

**The comparison itself.** A paired C0/C1/C2 comparison on a **live** model — the
gate's actual stimulus — cannot be run, because
`live_provider_budget_authorized: false` (§3). What is missing is not a harness: it is
the model that would make `completionQuality` a *variable*.

---

## 8. U05 — 独立 canary (executed)

### What was run

Two things, and the difference between them matters.

**(a) The existing procedure script, re-run as-is.**
`node qualification/results/M9.20-real-tasks/u05-canary.mjs` → **exit 0**, 8 PASS /
0 FAIL / 2 BLOCKED_EXTERNAL. Its gates re-run the built launcher, `--dump-config`
resolution, the sandbox enforcement claim, `tsc`, the bundle-patch declaration, the
daily-home write check, and a positive control (F8) for that check.

**Two honest limits of that script, measured rather than assumed:**

1. **Its F6 passes vacuously, and the script says so.** `D:/DSH/home/daily` does not
   exist on this machine (nothing is promoted), so "the daily home was not written" is
   a statement about an absent directory. F8 is the positive control and it does have
   teeth (a deliberate write moved the control digest
   `e3b0c442…` → `e6b6b67d…`).
2. **It never invokes the real install path.** It builds its profile with
   `mkdtempSync` + a hand-written `package.json` + a hand-made junction, and runs in a
   **temp** home. It therefore cannot observe whether the deployment's own install path
   swaps the composed tree.

**(b) A real upgrade through the real install path — NEW, in this session.**
`qualification/results/R7-real-tasks/canary-rollback.mjs` → **exit 0**, **19 PASS /
0 FAIL**. Against a **real `DSH_HOME`** at `D:\DSH\home\canary11` (new; the
other agents' `canary`, `canary3`, `canary5`–`canary10` were **not touched**), seeded
with a copy of real state from `canary2` (**credentials excluded**, asserted):
staging two immutable version directories, installing the old artifact with the real
`dsh plugin --profile canary11 add link:…` (pinned pnpm 11.7.0 through the launcher),
measuring the composed tree, installing the new artifact over it, and measuring again.

The decisive measurement is that the **composed deployment really moved**:

```
S3  --dump-config → budgetCeiling: 200   (old artifact's patch config)
S6  --dump-config → budgetCeiling: 250   (new artifact's patch config)   ← the tree moved
```

and the new artifact **really booted with the extension loaded** (S7):

```
[PASS] S7 the NEW version boots through the real launcher with the EXTENSION LOADED,
       and completes a real turn: exit 0; the turn ended completed; no "did not activate"
       warning; the scripted route made a real tool call and a real session write on disk
```

### The activation check is the load-bearing part, and it caught a real defect

An earlier run of this script reported the boot as **succeeding while the product was
absent**. The launcher exited 0 and the turn completed, but:

```
dsh: warning: 7 entries did not activate
daily-work-host (dsh-daily-work/host): failed to import
daily-web-search (dsh-daily-work/web-search): failed to import
…
```

The cause was **in my staging**, not in the deployment: the version directory had no
`node_modules`, so `lib/host-plugin.js` could not resolve `@deepseek-ai/cordis` by bare
specifier. The fix was to reproduce the package's own peer-link layout in the staged
copy. The script now treats that warning as a **failure of the boot step**, because
"exit 0 with the product absent" is precisely the green light that proves nothing. This
is recorded because it is the exact fake-closure shape this project has recorded
repeatedly.

### Maximum offline claim

> A canary procedure that **does not write the daily home** (with a positive control
> proving the write check has teeth), **plus a real artifact upgrade through the real
> `dsh plugin` install path against a real `DSH_HOME`**: the composed tree measurably
> moved, and the upgraded deployment **booted with the extension loaded** and completed
> a real turn with a real tool call and a real session write.

### Blocked remainder

**No new version was validated.** `compatibility.lock.json` pins the checkout at
`ddefc45fbc7f8e46dd73185e68295696d1297887` with `distribution_tested: false` and
`scope: LOCAL_IMPLEMENTATION_ONLY`, so no network fetch of a newer artifact is
authorized. The upgrade executed here is a **real artifact swap through the real
install path**, but the two artifacts differ in **version string and patch config
only** — their `lib/` payload is **byte-identical** (`libIdentical: true`). What is
**not** validated: that a newer release composes, boots, or preserves this extension's
contract. A model version likewise cannot be exercised.

---

## 9. U06 — 回退 (executed)

### What was run

`qualification/results/R7-real-tasks/canary-rollback.mjs`, steps S10–S18, against the
real `canary11` home. The rollback is real at every layer:

- **S10** the old artifact reinstalled through the real `dsh plugin` path;
- **S11** the composed tree measured **back** on the old artifact
  (`budgetCeiling: 250 → 200`);
- **S12** the **cold pre-upgrade consistency snapshot restored byte-for-byte** —
  `the RESTORED HOME STATE digest e7e2e7b1… equals the SNAPSHOT digest e7e2e7b1…`,
  compared **across different directories by the same rule** (an earlier version of the
  script compared the snapshot to itself and would have passed for any restore,
  including one that did nothing — that is fixed and the fix is why the comparison is
  now meaningful);
- **S13** the **old artifact booting against the restored state** with the extension
  loaded, completing a turn;
- **S15** the effect **reconciled from the world without re-sending**: transport
  invocations **1 → 1**;
- **S16** a **separate process** reads the world file and still finds the effect
  (`{"stillPresent":true,"resultRef":"world-1"}`);
- **S18** the world still holds the effect after the software went back.

The effect ledger is the **real `src/effects.ts`** over the real storage domain. The
"remote" is a **durable file** written by a real `perform`, deliberately a file rather
than an in-process counter: a counter proves nothing after its process exits, and the
claim under test is only meaningful if a **later process** can read it — which S16
does.

### A recorded U06 claim is corrected by measurement

`qualification/results/M9.20-real-tasks/u06-rollback.json` records step **R8a** as PASS:

> "the facility refused to open: domain 'dsh_daily_effects': stored record 'eff_…' in
> table 'operations' does not match its schema"

and `u06-rollback.mjs` explains that refusal in its own comment as the consequence of
the state rewind: *"The effect record lives in the state that was just rewound… and the
domain facility then refuses to open."*

**That explanation does not hold**, and it is checkable against the script's own code:

- `u06-rollback.mjs:143` — `stateRoot = join(work, 'state')` ← the thing rewound
- `u06-rollback.mjs:229` — `effectStore = join(work, 'effect-store')` ← a **SIBLING**
- `u06-rollback.mjs:300-302` — `rmSync` + `cpSync` on **`stateRoot` only**;
  `effectStore` is never rewound

So the rewind cannot be the cause of a refusal to read a record in `effectStore`.

**The actual cause:** `u06-rollback.mjs`'s adapter returns `{ kind: 'accepted', resultRef }`.
The ledger's contract (`src/effects.ts:253-256`) is
`EffectPerformResult = { status: 'confirmed' | 'not_started' | 'unknown', … }` — there is
**no `kind` field**. So `result.status` is `undefined`, `send()` writes
`status: undefined` into the record (`effects.ts:868-877`), and the zod enum rejects it
on the next open. (This also explains why the same script's R3 detail reads
`outcome undefined`.)

**Isolated by a probe rather than argued.**
`qualification/results/R7-real-tasks/probe-u06-refusal-cause.mjs` → **exit 0**. Two
arms, identical except for the adapter's return shape, and **neither store is ever
rewound**:

```
ARM A  { kind: 'accepted' }      → on-disk status: undefined (typeof undefined)
                                   re-open over the SAME store succeeded: FALSE
                                   refusal: domain 'dsh_daily_effects': stored record
                                            'eff_5a19ae09…' … does not match its schema
ARM B  { status: 'confirmed' }   → on-disk status: "confirmed" (typeof string)
                                   re-open over the SAME store succeeded: TRUE
                                   refusal: none
```

ARM A reproduces the recorded refusal **with no rewind in the picture at all**. The
refusal is caused by the malformed record, not by the state rewind.

**This is a finding, not a nitpick.** It matters because the recorded narrative points
at a *rollback design hazard* ("a state rewind destroys local knowledge of an effect")
which the evidence does not support — the actual hazard is an *adapter contract
violation that silently writes an invalid record*. My own first version of
`canary-rollback.mjs` had the identical bug and reported `ledger outcome undefined`;
the probe is what corrected it, and the corrected run reports
`ledger outcome confirmed`.

The genuine rewind consequence, now measured directly at step **S14**, is the opposite
of a refusal:

```
[PASS] S14 after the rewind the ledger opens cleanly and holds NO record of the effect:
       the ledger opened with no complaint; its record of eff_6b528bab… is ABSENT.
```

The ledger opens **cleanly** and simply holds **no record** of the effect — because the
restored state predates it. That is still the reason reconciliation must be driven from
the world by operation id, and it is why `EFFECT_LIMITS` requires a queryable remote
before any effect may run automatically. But it is a **silent absence, not a refusal**,
and the difference matters to anyone writing a rollback procedure against this ledger.

### Maximum offline claim

> A real rollback restores the **old artifact** through the real install path and the
> **old cold consistency snapshot** byte-for-byte, boots the old artifact against the
> restored state, and **reconciles an external effect from the world without re-sending
> it** (1 → 1), reporting the effect as **still present** — read back by a **separate
> process**. Rolling back software is **not** reported as rolling back the world.

### Blocked remainder

- **The remote is a file on this machine**, not a network service — no outbound
  network is authorized. Its durability across processes is real; its remoteness is
  not. A real remote's availability, idempotency semantics and eventual consistency are
  outside this machine.
- **No real newer version was rolled back**: the "new" artifact is the same `lib/`
  payload with a bumped version string and patch config (§8).
- **No live effect was produced** — `live_provider_budget_authorized: false`.

---

## 10. What is NOT proven (explicit)

Read this as the authoritative list of gaps. Anything not listed here but claimed
above was executed.

1. **No model turn was run anywhere.** U01's fix, U02's audit, U04's "quality" and
   every U03/U05/U06 model route are scripted. No provider was contacted and no
   budget was consumed.
2. **U04's comparison was not made.** With a scripted model, `completionQuality` is a
   constant and the cost series is identical across groups. The gate's actual
   question — does C2 do better work than C1 — **is not answered**.
3. **U02's audit was not performed by a model**, and no web search ran.
4. **U03's load is not "sustained" in the gate's sense.** Six cycles of a 4-child
   wave bounds a leak over that range; it does not exclude a slow one, and it is not a
   long session.
5. **No newer DSH/Node/plugin/model version was validated.** The U05 upgrade is real
   machinery over a fixture difference (version string + patch config; `lib/`
   byte-identical).
6. **No real remote was reconciled** (U06). The remote is a local durable file.
7. **U01's "multi-file" claim is overstated by the acceptance.** The bug's blast
   radius does span `counting.ts` and `host.ts` (verified statically), but the
   acceptance never imports `host.ts` and catches a one-file fix only through its
   direct `holdsSlot` assertions — measured, §4.
8. **The recorded U06 step R8a explanation is not supported by the evidence**, and
   the actual cause is an adapter contract violation. §9.
9. **The full test suite was not run.** Other agents are editing sibling files in this
   tree; only this agent's files were run.
10. **U05's `D:/DSH/home/daily` does not exist**, so the existing script's F6 is
    vacuous (its own F8 positive control is what gives it teeth).

---

## 11. Evidence index

All paths relative to `D:\DSH\work\dsh-native-daily`.

| File | What it is |
|---|---|
| `qualification/results/R7-real-tasks/canary-rollback.mjs` | The real canary upgrade + rollback rehearsal (runnable) |
| `qualification/results/R7-real-tasks/canary-rollback.json` | Its 19-step result record |
| `qualification/results/R7-real-tasks/canary-rollback.log` | Its full stdout transcript |
| `qualification/results/R7-real-tasks/probe-u06-refusal-cause.mjs` | The two-arm probe isolating the U06 R8a cause |
| `qualification/results/R7-real-tasks/probe-u06-refusal-cause.json` | Its result record |
| `qualification/results/R7-real-tasks/u01-u04-tests.txt` | The 21-test vitest transcript, exit 0 |
| `qualification/results/R7-real-tasks/tsc-package.txt` | `tsc -p tsconfig.json --noEmit` → exit 0 |
| `qualification/results/R7-real-tasks/tsc-check.txt` | `tsc -p tsconfig.check.json` → exit 0 |
| `qualification/results/R7-real-tasks/u05-canary-tmp-home.{json,log}` | The existing u05 script re-run, report redirected here so it did not clobber `M9.20` |
| `qualification/results/M9.20-real-tasks/u03-load.json` | U03 measured series (regenerated this session) |
| `qualification/results/M9.20-real-tasks/u04-paired.json` | U04 axes + statistics (regenerated this session) |
| `D:\DSH\home\canary11\` | The real canary home left behind as the rehearsal's artifact: `versions/`, `snapshots/pre-upgrade/`, `remote-world.json` |

The canary home is **left in place** deliberately so a reader can inspect the two
staged version directories, the snapshot and the world file. It holds **no
credentials** (asserted at step S0). `D:\DSH\home\canary11-explore` (a scratch home
used while developing the script) was removed.

---

## 12. Exact rows to add to `docs/GAPS.md`

`docs/GAPS.md` was **not edited**. The rows below are the exact text to append, in the
file's existing table style.

```
| G-R7-01 | U01–U04 cannot be closed as "real tasks" without a live model | OPEN | `compatibility.lock.json` -> `runtime_authorization.live_provider_budget_authorized: false`, with `budget_amount: null`, `currency: null`, `deadline: null`. U01's fix, U02's audit, U04's quality axis and every U03 model route are scripted. U04's actual comparison is therefore NOT MADE: `completionQuality` is a constant and the cost series is identical across C0/C1/C2. Unblocking requires the lock to authorize a budget (amount + currency + deadline) and to widen `scope` from `LOCAL_IMPLEMENTATION_ONLY`. The `null` budget fields mean the lock cannot currently express a cost at all. |
| G-R7-02 | U01's acceptance does not exercise the second consumer it claims | OPEN | `u01-coding-loop.test.ts`'s header says "A one-file fix in `counting.ts` would leave `admit` refusing a re-run of a confirmed task, which the acceptance catches." Measured: a one-file fix that bypasses `holdsSlot` inside `counting.ts` DOES fail the acceptance, but only through two DIRECT `holdsSlot` assertions; all five `countRun`/`mayAdmit` assertions pass. The acceptance never imports `host.ts` and never calls `admit`. The oracle still discriminates, so U01 is not invalidated; the stated mechanism is. Same defect class as G-FIX-04. |
| G-R7-03 | u06's recorded step R8a is explained by a mechanism the code does not implement | OPEN | `M9.20-real-tasks/u06-rollback.json` records R8a as a schema refusal and `u06-rollback.mjs` attributes it to the state rewind. In that script the effect store (`:229`) is a SIBLING of the state root (`:143`) and only the state root is rewound (`:300-302`). `R7-real-tasks/probe-u06-refusal-cause.mjs` reproduces the refusal with NO rewind, isolating the cause: the script's adapter returns `{ kind: 'accepted' }` where `src/effects.ts:253-256` requires `{ status: 'confirmed' }`, so `status` is written as `undefined` and the zod enum rejects the record on the next open. The real rewind consequence (measured at R7 step S14) is a CLEAN open with an ABSENT record, not a refusal. A rollback procedure written against the recorded narrative would handle the wrong failure. |
| G-R7-04 | U03's load is not "sustained" in the gate's sense | OPEN | Six cycles of a 4-child wave is the longest run that respects this environment's CPU discipline. It BOUNDS a resource leak over that range (resource drift +1, listener drift 0) but does not exclude a slow one, and it is not "a long Session". Recorded in `u03-load.json`'s own `notExercised`. |
| G-R7-05 | U05's upgrade is real machinery over a fixture difference | OPEN | The R7 rehearsal installs a genuinely separate artifact through the real `dsh plugin` path and the composed tree measurably moves (`budgetCeiling` 200 -> 250), but the two artifacts differ only in version string and patch config; their `lib/` payload is byte-identical (`libIdentical: true`). No newer release is installable: the checkout is pinned with `distribution_tested: false` and `scope: LOCAL_IMPLEMENTATION_ONLY`. "A new version works" is NOT validated. |
| G-R7-06 | U06's "remote" is a durable local file, not a network service | OPEN | No outbound network is authorized, so the effect whose survival the rollback must reconcile is a file on this machine. Its durability across processes is real and was measured by an independent process (R7 step S16); its remoteness is not. A real remote's availability, idempotency semantics and eventual consistency are unmeasured. |
| G-R7-07 | U05's existing F6 check passes vacuously | OPEN | `M9.20-real-tasks/u05-canary.mjs` F6 ("the daily home was not written") reports PASS because `D:/DSH/home/daily` does not exist on this machine. The script states this and adds F8 as a positive control, which does have teeth. Until something is promoted to the daily home, F6 is a statement about an absent directory. The R7 rehearsal addresses the same hazard differently: its canary home holds real state, so a stray write has somewhere to land. |
```

---

## 13. Final verification of this session's own two gates

Both were run from `packages/dsh-daily-work`, which is where the configs live:

```
$ node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
EXIT=0

$ node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json
EXIT=0
```

No source file outside this agent's ownership was modified. `host.ts`, `record.ts`,
`kernel-lifecycle.ts`, `verification-gates.test.ts`, `worktree-isolation.ts`,
`writers-plugin.ts`, `perf-metrics.ts`, `eco.test.ts`, `programmatic-scope*.ts`,
`history-*.ts`, `web-provenance.ts`, `artifacts.ts`, `observations.ts`, `data-*.ts`,
`upg-gates.test.ts`, `durability-*.ts`, `sec-gates.test.ts`, `profiles/**` and
`docs/GAPS.md` were **not touched**. `D:\DSH\src\dsh-src` was **not modified** (read
only; `git rev-parse HEAD` confirmed the pinned commit).

### Note on git state, for accuracy

**This agent ran no `git commit` and no `git push`.** However, `git status` at the end
of this session shows the R7 files as *tracked* rather than untracked, because
**another agent's commit swept them in**: commit
`1e0b8d6917d24d40e2f72f512a9e42a19931997c` ("R10 security re-derivation: FAILs
sharpened, SEC-08 corrected stricter", authored 2026-09-20 03:21:01 by
`DSH Native Daily Agent`) captured `canary-rollback.mjs` and
`probe-u06-refusal-cause.mjs` while they were being written. That commit is not this
agent's, and the files have since been edited further (the `libIdentical` note, the
activation check, and the S14/S18 corrections all post-date it), so the working-tree
versions are ahead of what was committed. Recorded because the instruction was "do not
commit", and a reader checking `git log` would otherwise see these paths and conclude
otherwise.

### Note on the two transient `tsc` failures

During this session `tsc -p tsconfig.check.json` briefly reported errors in
`src/data-plane.test.ts`, `src/research-chain.test.ts` and (transitively)
`packages/fs/tool-fs/src/sandbox.ts`. Those are **other agents' files, mid-edit** —
`data-plane.test.ts` and `research-chain.test.ts` were being written at 03:26, seconds
before the check. This was confirmed two ways: (1) a narrowed `tsconfig` including
**only this agent's five files** type-checks with **0 errors**; (2) a re-run once the
sibling edits settled exits **0**. Both final gate runs are recorded in
`tsc-package.txt` and `tsc-check.txt` as **exit 0**.

No host was left running: every launcher invocation in this session used `plugin`,
`--dump-config`, or `--json` (one-shot, no listening socket), and a final sweep found
**0** node processes whose command line names `canary11`. The listeners on
`127.0.0.1:3189` and `127.0.0.1:32101-32104` were verified by command line to belong to
**other agents'** `--profile daily` hosts and to a local proxy (`verge-mihomo.exe`), not
to this session. `D:\DSH\home\canary11-explore` was removed; `D:\DSH\home\canary11` is
deliberately retained as evidence and contains no credentials.
