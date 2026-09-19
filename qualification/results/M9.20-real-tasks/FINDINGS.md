# M9.20 — real tasks, sustained load, upgrade and rollback (U01–U06)

**Date:** 2026-09-19
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)
**Evidence:** `tests.txt` (28 passed across six files, exit 0), `tsc.txt` (both runs exit 0),
`source-digests.txt`, `u03-load.json`, `u04-paired.json`, `u05-canary.json`,
`u06-rollback.json`, and the two runnable scripts `u05-canary.mjs` / `u06-rollback.mjs`.

## Verdict summary

| gate | was | now | what is genuinely proven |
|---|---|---|---|
| **U01** coding loop closed | NOT_RUN | **PASS** | A real multi-file bug in a real file fails a **frozen** acceptance and the real fix passes it; the acceptance is byte-frozen throughout and a patch that edits the test instead of the code is **detected**. |
| **U02** research loop closed | NOT_RUN | **PASS — live half BLOCKED_EXTERNAL** | A conflicting-source audit whose every conclusion is bound to a quoted line at a pinned revision, spot-checked mechanically; the dispute is present, not smoothed away. |
| **U03** sustained daily load | NOT_RUN | **PASS — measured range reported** | Six waves of top-up with pause/resume interleaved. Resources and listeners **flat** (5 and 14, drift 0), cost exact (4/cycle), two runs in one process share no state. |
| **U04** paired comparison | NOT_RUN | **PASS — controlled fixture, no winner** | C0/C1/C2 composed as real presets differing by exactly one row per step, three axes reported separately, cost identical across groups, **no winner declared**. |
| **U05** independent canary | NOT_RUN | **PASS — new-version half BLOCKED_EXTERNAL** | A real canary procedure executed against the current version in a fresh temp home: 8 gates re-run, the daily home untouched, with a positive control proving the write check has teeth. |
| **U06** rollback | NOT_RUN | **PASS** | A real rehearsal over a temp home: old artifact + old consistency snapshot restored byte-for-byte, the external effect **reconciled and still present in the world**, and a real finding about what a state rewind does to the effect ledger. |

The headline honest statement: **five of the six gates close on evidence; the
live halves of U02 and U04 and the new-version half of U05 do not, and they are
recorded as BLOCKED_EXTERNAL rather than dressed up.**

---

## U01 — the coding loop, closed, with a frozen independent acceptance

### The fixture, and what is real in it

No live provider is authorized, so the model's place is taken by a scripted patch.
Everything else is real: the code under repair is the **real `src/states.ts` +
`src/counting.ts` + `src/record.ts`** copied into a temp tree; the bug is a real
bug with a real consequence; the acceptance is a **real vitest run** of a real
test file authored against the correct behaviour; and the acceptance is **frozen
by sha256 before the patch exists**.

### The bug, and why it is not a toy

`holdsSlot` is the single predicate INV-C1 names as the source of truth for slot
occupancy. The injected bug makes it return `true` for the two **terminal**
states, `confirmed` and `cancelled`. The consequence: a confirmed task keeps
holding its slot forever, so `capacityDeficit` never recovers and the run can
never top up. Ten confirmed tasks look like ten running children and the target
is permanently blocked.

It is multi-file because the same predicate is consumed in **two** places that
must agree, and the test asserts both against the real sources:

- `counting.ts:107` — `if (holdsSlot(task.state)) held += 1`, which drives
  `capacityDeficit` and therefore `mayAdmit`;
- `host.ts` — `holdsSlot(existing.state)` in `admit`, which refuses a re-run of a
  task whose existing state holds a slot.

A one-file fix would leave the other consumer disagreeing.

### The measured sequence

| step | observation |
|---|---|
| baseline: the UNPATCHED real source | acceptance **exit 0** (a fixture whose "correct" tree already failed would be measuring the fixture, not the bug) |
| bug injected into the staged copy | acceptance **exit ≠ 0**, and the failure names `holdsSlot` / `capacityDeficit` — so it failed for the right reason, not on an import crash |
| the fix: revert the staged file to the real source | acceptance **exit 0** |
| the freeze | acceptance file sha256 **unchanged** across all three runs |

The freeze is what makes "the result does not depend on the final answer being
scored" mechanical: the scored artifact is fixed before the change under test is
made. And the anti-cheat half is itself a test — a patch that keeps the bug and
**rewrites the acceptance to match it** is detected, because the digest no longer
matches the authorized one, and the weakening is visible in the diff (the
assertions really did change direction).

### What U01 does NOT prove

**That a model would find the bug.** That is U04's subject and it is
BLOCKED_EXTERNAL. What is proven is the mechanical part: the loop closes on a real
code change judged by an oracle the change is not allowed to touch.

---

## U02 — the research loop, closed on a conflicting-source audit

### The honest shape

The live-search half is **BLOCKED_EXTERNAL**: no network is authorized. So the
audit runs against **local sources**, and the two properties that make a research
loop real are kept: the sources genuinely conflict, and every conclusion is bound
to a quoted line at a known revision.

### The conflict, and why it is real

Subject: DSH's Windows sandbox boundary at the pinned checkout. Two real documents
answer the same question differently:

- **Source A** — `packages/sandbox/sandbox-windows-acl/src/index.ts:24-25`:
  > writes are restricted; reads, network, and process visibility are NOT
  > (WRITE_RESTRICTED intersects only write accesses);

- **Source B** — the seam's own contract, which describes what `confine()` is FOR
  without making the read/network claim in those words.

A reader who takes A at face value concludes E01 is structurally impossible on
Windows. A reader who takes B alone might conclude the sandbox is a general
confinement boundary. **The dispute is the audit's product**, and finding A5 is
recorded as `disputed` rather than resolved by authority.

### The spot-check, and its teeth

Every finding carries `citations`, `wouldBeOverturnedBy` and `unknowns`, each
asserted non-empty — a finding with no unknowns is the shape of an overclaim. Each
citation is `{source, revision, line, quote}`, and the spot-check re-reads the
file at that revision and requires the quote **verbatim on the named line**. The
negative control is deliberate: a citation with a real file, a real line number
and a quote that **inverts** the source's claim is shown to be caught. The reader
also refuses a citation naming any revision other than the pinned one, so a
re-check against a moved checkout is a different claim rather than an invisible
drift.

Seven citations were checked, all found verbatim. Two line numbers had to be
corrected during construction (an off-by-one against the real file), which is
itself evidence the check is mechanical rather than a restatement of what the
author believed.

### What U02 does NOT prove

**That a model performed the audit, or that a web search was exercised.** The
audit artifact is data walked by a mechanical checker. The live half stays
BLOCKED_EXTERNAL.

---

## U03 — sustained load, measured range

### The rig, and one fixture error worth recording

Real stack: `@deepseek-ai/dsh-agent-loop`, the real `ctx.subagents` continuable
machinery, the real in-process spawn provider, a real durable JSONL Session per
child, and the real storage domain. The model adapter is scripted — a provider
boundary, not a second loop.

**The fixture error.** The first version reused `concurrency.test.ts`'s **gated**
adapter, which holds every child's model call open. That is right for "ten in
flight at once" and **wrong here**: after the first wave, `maxActiveSubagents` was
full of parked children and every later admission was refused for a real capacity
reason. The observed series was `[4,0,0,0,0,0]` — which *looked* like a leak and
was not. A fixture that holds the resource under test cannot also measure its
release. The adapter was changed to complete, and the corrected series is below.

### The measured range — six cycles, target 4

| cycle | resources | listeners | heap (MB) | admitted | spent |
|---|---|---|---|---|---|
| 0 | 5 | 14 | 67.4 | 4 | 4 |
| 1 | 5 | 14 | 54.4 | 4 | 8 |
| 2 | 5 | 14 | 65.5 | 4 | 12 |
| 3 | 5 | 14 | 51.9 | 4 | 16 |
| 4 | 5 | 14 | 63.3 | 4 | 20 |
| 5 | 5 | 14 | 74.9 | 4 | 24 |

- **Resources**: min 5, max 5, **drift 0**, largest step 0.
- **Listeners**: min 14, max 14, **drift 0**, largest step 0.
- **Heap**: oscillates 51.9–74.9 MB with **no growth trend** (the series is not
  monotone; a leaking run's would be).
- **Cost**: exactly 4 per cycle, 24 total, `unknownReserved: 0`, `overage: 0`. No
  cost disappeared.
- **State**: a second run created in the same process starts with zero tasks,
  zero spend, zero tombstones, and the first run is unchanged by it.

A **control arm runs first** so one-time host initialization is charged to the
control rather than read as a leak — the G-FIX-08 lesson. The control's largest
step is asserted ≤ 2, because the load arm's interpretation depends on it: if the
control drifts, a drift in the load arm is not attributable to the load.

`process._getActiveResourcesInfo()` is used, **not**
`process._getActiveHandles()`: the latter does not report timers, which is exactly
the resource a plugin that forgets its disposer leaks (G-FIX-08).

### What U03 does and does not cover

**Exercised:** six waves of rolling top-up through the real `startContinuable`
seam; the full admission state machine per task (`executing → settling →
confirmed`); pause refusing admission and resume restoring it, alternating by
cycle; two runs in one process, separately keyed; 48 model calls total.

**NOT exercised, and it matters:** no live provider (cost is this project's own
reservation arithmetic, not a provider invoice); no Web host (host-level sockets
and watchers are not covered); and the load is **modest by design** (CPU
discipline). A small series **bounds** a leak over the range run; it does not
exclude a slow one. The range is reported for exactly that reason — a verdict
alone would overstate what six cycles can support.

---

## U04 — paired comparison, and the refusal to declare a winner

### What this is, said before any number

**A controlled-fixture comparison, not a benchmark.** No live provider is
authorized, so the model is a scripted adapter and the quality axis is a scripted
outcome. The numbers measure the rig and the control groups' structural
differences. They do not measure model capability.

### The groups differ by exactly one row per step

C0/C1/C2 are real presets mounted by the real roster, written as a prefix chain so
"one explainable difference per step" is **checkable**:

```
C0 rows: [base-tool]
C1 rows: [base-tool, agent-instructions]        (+1)
C2 rows: [base-tool, agent-instructions, daily-work-tools]   (+1)
```

`c1.startsWith(c0)` and `c2.startsWith(c1)` are asserted, so a step cannot have
removed anything. The measured catalogs confirm it: C0 `[base_read]`, C1
`[base_read, repo_instructions]`, C2 `[base_read, repo_instructions, work]` —
**only C2 carries `work`**, which is its whole reason to exist in the comparison.

### The three axes, reported separately

| axis | C0 | C1 | C2 |
|---|---|---|---|
| **completion quality** | `scripted: one text answer, no tool call` | same | same |
| **cost** (model calls / output tokens) | 1 / 4 | 1 / 4 | 1 / 4 |
| **wall time** (mount + create + one turn, ms) | 26 | 7 | 9 |

Quality is **identical by construction** and that is stated rather than presented
as a finding. Cost is **identical across groups**, which is the expected result
for a controlled comparison: the compositions differ in what the agent is
OFFERED, not in what this scripted task SPENDS.

### Two measurement errors found while building this

1. **The turn never ran.** `ctx.agents.create({setup})` runs the setup callback
   *before* the driver starts, so a turn submitted afterwards was never claimed —
   the adapter was called **zero** times and the cost axis read zero for every
   group. A zero series compared across groups reports a difference of nothing
   while looking like a measurement. Creating through `agentLoop.create` and
   mounting the preset afterwards gives a live driver.
2. **The shared adapter's counters are cumulative.** The adapter is shared across
   groups (that is what makes the model a controlled variable), so reporting its
   raw totals attributed C0's tokens to C2 and produced a monotone series
   `(4, 8, 12)` that *looked* like a finding about the compositions. Per-group
   deltas are the measurement, and the corrected series is `(4, 4, 4)`.

### The statistical position, as data

`observationsPerGroup: 1`. With one observation per group there is **no variance
estimate**, so no difference on any axis can be distinguished from noise. The
artifact carries `winnerDeclared: false` and a reason, and the test asserts that
field is false — so a later edit that added a winner would have to change the data
and fail.

**No winner is declared, and none can be from this run.**

---

## U05 — the canary procedure, executed

### What is honest here

A new DSH version cannot be installed: the checkout is pinned and no network is
authorized. So the gate's honest form is a **real procedure, executed now against
the current version in a fresh temp home**, with the "new version" half recorded
as BLOCKED_EXTERNAL. A procedure that has never been executed is a plan, not a
gate.

### The eight gates re-run, all PASS

| id | gate | result |
|---|---|---|
| F1 | the built launcher exists and runs | PASS — sha256 `69c49c871735dc7e…` |
| F2 | the profile resolves and includes the extension host row | PASS — `--dump-config` exit 0, 368 lines, `daily-work-host` present |
| F3 | the sandbox enforcement claim is unchanged | PASS — write-only boundary claim present **and** `windows-acl → 'partial'` |
| F4 | the extension typechecks against the checkout | PASS — `tsc --noEmit` exit 0 |
| F5 | the extension declares a bundle patch and is built | PASS — `dsh.bundle.patch` declared, patch file exists, `lib/host-plugin.js` built |
| F6 | the daily home was not written | PASS — file-list digest identical before/after |
| F7 | the canary home WAS exercised | PASS — 3 files after the run |
| F8 | the daily-home write check has teeth | PASS — a deliberate write moved the control digest |

### Why F5 is a separate gate from F2

**G-FIX-04 is the reason.** A package can compile, declare no `dsh.bundle.patch`,
and be installed as a plain dependency that activates **no layer at all** — and a
direct-mount test still passes while the plugin is never loaded. F2 proves the row
resolves; F5 proves the package is *loadable as a bundle*. They fail for different
reasons and are reported separately.

### F8 exists because F6 passes vacuously

The daily home **does not exist** on this machine (nothing is promoted), so F6
cannot fail — a check that cannot fail is not a check. F8 is the positive control:
the same digest machinery is pointed at a directory that *does* exist, a write is
made, and the digest is shown to move. Without F8, F6's PASS would be a statement
about an absent directory dressed as a statement about the canary.

### Two errors corrected during construction

- **F3 read the wrong file.** It looked for `enforcement: 'partial'` in the
  **windows-acl backend** and reported FAIL. The boundary *claim* is in that
  backend's header; the enforcement *value* is a static table in the **selector**
  (`sandbox-local/src/index.ts:177-187`). Both are now checked where they live.
- **F2 borrowed the daily profile.** `--profile daily` reads the daily home — the
  one thing this gate forbids touching. It failed with `profile "daily" does not
  exist`, which was correct and for the right reason. The canary now builds its
  own profile in the temp home.

### What U05 does NOT prove

**That a new version works.** Nothing new was installed. The procedure is real and
was executed; the upgrade is BLOCKED_EXTERNAL. A live provider is also
BLOCKED_EXTERNAL, so no model version can be exercised.

---

## U06 — the rollback rehearsal

### The three clauses, exercised

1. **Old artifact + old consistency snapshot.** The old version is staged as an
   **immutable version directory** (`docs/OPERATIONS.md`: "Immutable version
   directory, new process. HMR is not a restart qualification"), and the snapshot
   is taken **while the state is quiescent** ("Never copy a live DB and call it a
   consistent snapshot"). The restore is verified by **tree digest**, not by
   presence: the restored state digest equals the snapshot digest exactly.
2. **External effects reconciled.** The new version performs a real effect through
   the **real `EffectLedger`** over the real storage domain. The rollback then
   reconciles it — and the transport is invoked **zero additional times**.
3. **Rolling back software is not rolling back the world.** After the rollback the
   remote **still holds the operation** (`resultRef: remote-1`), the
   reconciliation reports `confirmed`, and no reason string claims a reversal.

### The finding: a state rewind destroys LOCAL knowledge of an effect

This was discovered by running it, not by reasoning about it. The effect record
lives **in the state that was just rewound**. Rewinding to the pre-upgrade
snapshot removes the record of an effect the **world still remembers**, and the
domain facility then refuses to open at all:

```
DomainError: domain 'dsh_daily_effects': stored record
'eff_f668fd97f80b4033c1790267dfd69d13' in table 'operations' does not match its schema
```

The refusal is **correct** and is what `docs/OPERATIONS.md` asks for ("A schema
that cannot be migrated safely refuses to start rather than silently reading a
backup"). But it has a consequence a rollback procedure must state:

> **After a state rewind, reconciliation cannot be driven from the local ledger
> at all.** It has to be driven from the REMOTE, by operation id — which is
> exactly why `EFFECT_LIMITS` requires a queryable remote or an idempotency key
> before any effect may run automatically.

The rehearsal therefore does both: it records the refusal (step R8a) and performs
the reconciliation the way a real rollback must — by **querying the remote**.

### A fixture bug that was itself the failure mode the design names

The first counting fake keyed the effect on `intent.operationId`. `EffectIntent`
has no such field — the operationId is derived from `(kind, logicalKey)`
(`effects.ts:196`, `:204-210`) and is passed to the adapter as a separate
`identity` argument. The fake stored the effect under `undefined`, so the
post-rollback query asked about the real operationId, found nothing, and reported
`not_started` for an effect the remote had **actually performed**. That is
precisely the "remote that reports `not_started` for an operation it committed"
case `EFFECT_LIMITS` names as defeating the design — and it appeared here as a bug
in the fixture, caught because step R9 asserts the world still remembers the
effect. **A weaker R9 would have passed.**

### What U06 does NOT prove

No real newer version was installed or rolled back; the "new version" is the same
built artifact with a bumped version string and a schema bump. No real remote was
contacted. No live state store was rewound. The rehearsal is about the
**procedure**, and the report says so in its own `notExercised` field.

---

## Not run, and why

| item | status | reason |
|---|---|---|
| U02 live web search | **BLOCKED_EXTERNAL** | No network authorized. `live_provider_budget_authorized: false` in `compatibility.lock.json`. |
| U04 live paired comparison | **BLOCKED_EXTERNAL** | Same. A live run needs an authorized budget; a key being present would not authorize one. |
| U05 validation of a NEW version | **BLOCKED_EXTERNAL** | No new DSH/Node/plugin version is installable: the checkout is pinned and no network is authorized. |
| U05 live model version | **BLOCKED_EXTERNAL** | Same as U04. |
| U03 live provider cost | **BLOCKED_EXTERNAL** | Cost measured is the project's reservation arithmetic, not a provider invoice. |

## Safety and scope

- **No canary home was written.** `D:\DSH\home\canary5` was copied from, never
  modified. U05 asserts its own daily home is untouched and proves the check has
  teeth. The boot probes for E02 used a fresh temp `DSH_HOME` created by this
  work.
- **No network call was made.** U02's "sources" are local files; U03/U04 use a
  scripted adapter; U05 runs `--dump-config` and `tsc`; U06's remote is a counting
  in-process fake.
- **Every temp directory is removed.** U01's candidate trees, U03's session and
  store roots, U04's preset roots, U05's canary home and control directory, and
  U06's rehearsal root are all removed in a `finally`. U05 warns rather than
  silently leaving one behind.
- **No assertion was weakened.** The U03 fixture error and the U04 measurement
  errors were fixed by correcting the FIXTURE, not by relaxing the assertion, and
  both are recorded above.

## Reproducing

```sh
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"

# U01-U04 (vitest):
vitest run src/u01-coding-loop.test.ts src/u02-research-loop.test.ts \
           src/u03-sustained-load.test.ts src/u04-paired-comparison.test.ts

# U05-U06 (standalone scripts; each creates and removes its own temp root):
node ../../qualification/results/M9.20-real-tasks/u05-canary.mjs
node ../../qualification/results/M9.20-real-tasks/u06-rollback.mjs
```

Both scripts exit non-zero when a gate fails or is BLOCKED, so a green exit means
the executed gates passed and nothing was skipped.
