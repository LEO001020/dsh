# V8 — the CONCURRENCY family (CAP-01..CAP-13): the gate table

**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`, HEAD `c3b9dba`
**Pinned DSH checkout (read-only):** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
**Deployment identity:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
— verified MATCH by `python qualification/results/T1-spec/verify-identity.py` (28/28 checks) at the start of this work.
**Toolchain:** `node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run <file> --maxWorkers=1 --no-file-parallelism`, one file at a time, from `packages/dsh-daily-work`.
**Build measured against:** `lib/` as built 2026-09-20 07:10 (all `lib/*.js`), which is NEWER than every capacity source it compiles (`src/capacity.ts` 05:10, `src/host.ts` 05:10, `src/counting.ts` 04:xx). No stale-build window: the transcript below ran against a build that postdates its sources. Recorded because G-SEAM-29 was a stale-`lib/` false finding.

Every claim is labelled `[measured]` or `[read in source]`. Nothing is reported PASS from reading.

---

## 0. What this family inherits, and what it had to measure itself

T10 closed the capacity work and its gate table is `qualification/results/T10-capacity/GATE-TABLE.md`.
This slice reuses that work and does NOT re-run it at scale. Two things had to be
re-established rather than inherited:

1. **The identity moved.** T10's boot artifact was produced under `549732b5…`; the
   lock is now `0a0996f3…`, because `host_profile_digest`, `agent_preset_digest`
   and `agent_preset_id` had all gone stale (`c3b9dba`). The spec's rule is
   explicit — "NO PASS IS INHERITED … at THIS deployment identity" — so the
   composed-profile boot was **re-run** into `qualification/results/V8-capacity/`,
   not cited from T10.
2. **Two CAP oracles had no measurement anywhere**: the COLD RESUME admission path
   (CAP-02 names five paths; four were measured) and the last-credit contention
   arm (CAP-09). Both are measured in `capacity-v8-probe.test.ts`, added here.

The 30-real-children arm was **not** re-run: the cap's bindingness is already
established by a genuine refused `startContinuable` on a composed boot, and the
user's constraint forbids spawning children at scale. Cost of this slice: **one
host boot**, **ten real children in one existing test file** (T10's N=10 arm,
re-run), **one real child** in the new resume probe, and **zero children** in the
storm/credit/limit arms.

---

## 1. The gate table

| Case | Assertion | Exact command | Measured result | Verdict | Build |
|---|---|---|---|---|---|
| **CAP-01** | With 30 occupied, the 31st and 32nd are refused BEFORE publication; occupancy never exceeds 30; the refusal code and the high-water mark are recorded | `vitest run src/capacity.test.ts -t "the ADMIT/REFUSE BOUNDARY"` **and** the composed-profile boot | `occupied 30, highWater 30, refusals HOST_CAPACITY_REACHED=2`, code `HOST_CAPACITY_REACHED`; on the composed boot a real `startContinuable` was refused with `the host already holds 30 children and the hard capacity is 30`, `highWater 30` | **PASS** | `lib/` 07:10 |
| **CAP-02** | Every admission path shares one host-wide quota; a caller-supplied `maxDepth` cannot bypass the ceiling | `vitest run src/capacity.test.ts -t "creation path"`; `vitest run src/capacity-v8-probe.test.ts -t "COLD RESUME"` | continuable / one-shot / direct-factory / workflow-PTC each move the ledger 0→1; **cold resume measured here**: a resumed child is `isSessionBackedChild === true`, `origin: 'subagent'` survives persistence, and it TAKES a slot. `maxDepth: 99` and an omitted `maxDepth` are both REFUSED as `DEPTH_CEILING_EXCEEDED` | **PASS** | `lib/` 07:10 |
| **CAP-03** | A completion admits a replacement without waiting for the wave; the delay is recorded against the declared SLO | `vitest run src/scheduling.test.ts -t "single completion refills"`; `vitest run src/capacity.test.ts -t "REAL N=10"` | C02 timeline from `cap03-refill.txt`: `+0ms release child-0 / +12ms child-0 ended and left the registry / +13ms slot freed by confirmation / +36ms child-500 admitted (+23ms) / +36ms replacement reached a model request`. N=10: three rounds, each completing exactly ONE child while NINE stay active | **PASS (with a stated limit)** — **no SLO is declared anywhere in this repository** (`grep -rn "SLO"` over `src/`, `runners/`, `docs/` finds only comments saying none is frozen). The delay is therefore *reported*, not *asserted against a threshold* | `lib/` 07:10 |
| **CAP-04** | An unconfirmed cancel still occupies; no replacement is admitted into a freed-looking slot | `vitest run src/capacity.test.ts -t "cancel that has only been REQUESTED"`; `vitest run src/scheduling.test.ts -t "C07"` | `stopping` bucket occupies; real interrupt sent, child observed still `status: 'running'` after 200ms, `budget.reserved === 10`, premature refill `accepted: false`, `stopping: 1`; slot released only on the confirmed `cancelled` transition | **PASS** | `lib/` 07:10 |
| **CAP-05** | The root is not starved and is not counted as a child | `vitest run src/capacity.test.ts -t "the ROOT keeps its own inference budget"`; `vitest run src/scheduling.test.ts -t "settlement-driven turn"` | with ten children parked, the root reaches its OWN provider call (`sessionId === root.id`), `hasChild(root.id) === false`, ledger stays 10, `rootAvailable 500` / `childCeiling 9500`, a 9,501 admission refused for budget | **PASS** | `lib/` 07:10 |
| **CAP-06** | No filler or idle placeholder children; the shortage is reported with its reason and the root is notified | `vitest run src/capacity.test.ts -t "ready shortage with a high N"`; `vitest run src/scheduling.test.ts -t "C04"` | target 30, 2 ready → exactly **2** real children, `capacityDeficit 28`, `deficitReason 'insufficient_ready_tasks'`, outbox entries ≥2, real registry lists 2 | **PASS** | `lib/` 07:10 |
| **CAP-07** | The cap is host-wide across roots | `vitest run src/capacity.test.ts -t "two real roots share one host ledger"` | pool raised to 64 on purpose so a refusal can only come from the host ledger: root A takes 2, root B takes the last of 3, then BOTH are refused with `hard capacity is 3`; `highWater 3`, `refusals 2`, neither refused child exists in the registry | **PASS** | `lib/` 07:10 |
| **CAP-08** | Target changes are honest in both directions | `vitest run src/capacity.test.ts -t "raising and lowering the target"`; `vitest run src/target-setting.test.ts` | 3→5 admits two more immediately; 5→2 admits NONE and kills nothing (all five children still live and still hold slots, every `reservedCost` unchanged, `requestedTarget 2`, `terminalTombstones []`); revision reported and fenced (`SETTINGS_CONFLICT` on a stale write) | **PASS** | `lib/` 07:10 |
| **CAP-09** | Credit reservation is atomic; exactly one contender wins the last credit; an unknown stays conservatively reserved | `vitest run src/capacity-v8-probe.test.ts -t "last cost credit"` (new here) | **`accepted=1 refused=2 reserved=100 childCeiling=100 reasons=["budget_blocked","budget_blocked"]`** — three concurrent drains against ONE free credit, exactly one wins, ledger lands exactly ON the ceiling, both refusals name the budget. Unknown path: `retainUnknown` keeps the amount reserved and tightens admission (`childHeadroom` falls by 4) | **PASS** | `lib/` 07:10 |
| **CAP-10** | A completion storm neither duplicates nor misses a top-up; no overshoot past the target; the drain is re-triggerable | `vitest run src/scheduling.test.ts -t "C03"`; `vitest run src/concurrency.test.ts -t "coalesces concurrent drains"`; `vitest run src/capacity-v8-probe.test.ts -t "completion storm"` | the BALANCED shape PASSES: 3 freed / 3 requested → exactly 3 admitted, later refill admitted, 14 distinct children, no duplicate id. The **unbalanced** shape is a MEASURED DEFECT: `freedSlots=2 concurrentRequests=3 → admitted=3 heldAgainstTarget3=4` | **FAIL — see §2** | `lib/` 07:10 |
| **CAP-11** | A pause stops admission and does not silently resume; already-published effects are reported as stopping vs confirmed | `vitest run src/concurrency.test.ts -t "user pauses"`; `vitest run src/host.test.ts -t "paused"` | with free slots remaining, a pause admits nothing (`after.every(o => !o.accepted) === true`) and the real registry still lists exactly 2 children; `admit` while paused throws `/is paused/`; `resume` is a separate explicit call | **PASS (with a stated limit)** — see §3 for the two halves the oracle asks for that the record does NOT carry | `lib/` 07:10 || **CAP-12** | A cost overrun is recorded, not edited away; new admissions pause | `vitest run src/cost.test.ts -t "C11"` | reserve 1 / actual 3 → `spent 3, overage 2`, halt reason `actual spend 3 exceeded the reservation 1 made for this work by 2`; task keeps its own full spend; `admissionCheck` → `budget_overage_halt`; drain refused with that reason; `desiredTarget` unchanged at 10; an aux request that never reported usage is retained as an unknown and can only TIGHTEN admission | **PASS** | `lib/` 07:10 |
| **CAP-13** | Depth, family and global limits are each applied, and each refusal names which limit fired | `vitest run src/capacity-v8-probe.test.ts -t "depth ceiling and the host cap"` (new here); `vitest run src/capacity.test.ts -t "INDEPENDENT hard cap"` | three limits separated on ONE rig: pool 4 / host gate 30. Pool refusal (verbatim) `subagent limit reached (active child limit: 4); wait for an existing child to finish or complete this work with the current agents`; depth refusal (verbatim) `dailyWork: refusing child "v8-grandchild" at delegation depth 2; the deployment ceiling is 1. A caller-supplied maxDepth cannot raise this: the depth is read from the child's own durable header.`; `hostRefusals {HOST_CAPACITY_REACHED: 0, DEPTH_CEILING_EXCEEDED: 1}`, `hostOccupied 4`, `hostLimit 30` | **PASS** | `lib/` 07:10 |

**Score: 12 PASS, 1 FAIL (CAP-10).** No case is BLOCKED_EXTERNAL: every CAP oracle is
stated at T2 and none of them needs a paid provider. The live-provider arm is a
DIFFERENT gate (`UPG-07`, 30 non-empty children on a frontier provider) and is
recorded BLOCKED_EXTERNAL in T10's table, not here.

---

## 2. CAP-10 is FAIL, and the defect is measured with ZERO children

`WorkService.drain` (`host.ts:1242-1256`) coalesces like this:

```js
const inFlight = this.pendingDrain.get(runId)
if (inFlight !== undefined) await inFlight          // <-- awaits the OTHER drain
const task = this.runDrain(runId, requests, signal) // <-- no re-check of pendingDrain
this.pendingDrain.set(runId, task)
```

K concurrent callers await the SAME in-flight drain. When it settles they all
resume in one microtask batch and each starts its OWN `runDrain`. The
target/deficit check (`mayAdmit`) lives **inside** `runDrain` and reads a record
none of them has written yet, so all K observe the same deficit and all K admit.

**Measured, no real children, `capacity-v8-probe.test.ts`:**

```
V8/CAP-10 measured: freedSlots=2 concurrentRequests=3 admitted=3
  heldAgainstTarget3=4 acceptedIds=["child-70","child-71","child-72"] deficitAfter=0
```

The target was 3. Four tasks now hold slots, `capacityDeficit` reads 0 (so the
overshoot is invisible to the deficit reader), and a fourth child was admitted
past the target. The same defect reproduces through three REAL children in
`capacity.test.ts`'s annotated `it.fails` case, whose comment records the trace
`req(70) accepted=true, req(71) accepted=true, req(72) accepted=true` with the
deficit reading 2 for every one of them.

**Why the neighbouring CAP-09 arm does NOT have the same hole, and the contrast is
the finding.** The budget check is inside the single record `update`, so it is
atomic and CAP-09 passes; the target check is outside it, so it is not, and
CAP-10 fails. Two checks on the same path, only one atomic.

**Not fixed here.** `host.ts` is outside this agent's file ownership (T10 recorded
the same boundary). The fix is to re-check `pendingDrain` after the await — loop
until no drain is in flight — which makes the coalescing a real serialization
rather than a one-shot wait. Filed as found, not fixed.

**Honest limit on the verdict.** The spec's CAP-10 oracle is about a "completion
storm"; the *balanced* storm (3 freed / 3 requested) genuinely PASSES and is the
shape the shipped code was built for. What fails is the case where concurrent
requests EXCEED the free slots — which is precisely the case that oversubscribes,
and therefore the one the oracle exists to forbid. So CAP-10 is FAIL on the
property the oracle states, and PASS on the weaker shape that was tested first.

---

## 3. What CAP-11's oracle asks for that the record does not carry

CAP-11's oracle has two halves. The first half — "no new child is admitted and no
continuation silently resumes" — is **PASS** `[measured]`: a pause admits nothing
with free slots remaining, and `resume` exists only as a separate explicit call
(`host.ts:707`) with no caller anywhere in the product.

The second half — "the record states which already-published effects are still
stopping or awaiting reconciliation, and which are confirmed stopped" — is **not
satisfied as written**:

- `counts` (`counting.ts:40-60`) carries `stopping`, `quarantinedUnknown`,
  `confirmed` and `cancelled` as separate numbers, and `stopping`'s own doc says
  "Cancellation requested, not yet confirmed. Still holds a slot." So the
  *stopping* half is reported `[read in source]`.
- There is **no** "confirmed stopped" counterpart, and no "awaiting
  reconciliation" field. `grep -rn "reconcil\|awaiting\|settled" counting.ts`
  returns nothing, and `reconcile.ts` (which produces the reconciliation
  decisions) is not imported by `counting.ts` or by `tools.ts`.
- `pause` has **NO production caller at all**: `grep -rn "pause("` over the whole
  repo excluding `lib/`, `node_modules` and `*.test.ts` returns exactly one hit,
  the method's own definition at `host.ts:688`.

So the pause is a real service-level gate that a production path cannot reach,
which is the **same G-SEAM-31 shape one level down**. The case is marked PASS for
the half its evidence establishes, and the missing half is stated here rather than
smoothed over. A reader who needs the second half should treat CAP-11 as
**partially established**, and the missing mechanism as an open gap.

---

## 4. G-SEAM-31: the mandatory requirement is NOT met (the headline)

`qualification/results/V8-capacity/create-run-callers.txt` re-verifies this at
HEAD `c3b9dba`:

- `WorkService.createRun` has **exactly ONE** non-test caller in the whole
  repository: `src/durability-runner.ts:63`.
- `durability-runner.ts` is imported by **nobody** — and
  `durability-advanced.test.ts:1006` independently asserts
  `productionImporters('durability-runner.ts')` equals `[]`. So the CLI is itself
  in no production import graph.
- The model-facing `work` tool resolves the run FIRST and throws
  (`tools.ts:130-133`): *"this session has no active run; a run is created by user
  authorization"*. Its action enum is `['status', 'submit', 'finish']` — **there is
  no create action**.
- On the composed profile `[measured]`, `runReachable: false` with exactly that
  message.

**Consequence for this family.** Every N=10 case in §1 creates its run by calling
`service.createRun(...)` **directly** — a TEST-INSTALLED entry point, the same
weaker-oracle shape as a test-installed launch port. So:

- the capacity/refill **arithmetic is correct and bounded — PASS**, measured at
  the deployment's own numbers;
- the **composed profile cannot exercise it — FAIL**, because no user action
  reaches a run.

The cap itself is NOT in the "nothing calls it" class: the guard is mounted from
`WorkService`'s constructor, so `agent/created` is guarded **before any run
exists**, and a real child through the model-facing seam moves the ledger 0→1 on
a composed boot with no run in existence `[measured]`. The unreachable half is the
*managed run the cap governs*, not the cap.

This is why **CAP-10 carries the FAIL** in this family and CAP-01..CAP-09/CAP-13
carry PASS: their oracles are about the ledger's arithmetic, which is genuinely
measured. The one case whose oracle is about the product actually sustaining the
top-up through a completion storm is the one that must not be green on the
strength of a test-installed run.

---

## 5. The five CAP oracles that are about the ledger, and one that is about the product

Stated plainly, because the distinction decides which cases may be green:

| Case | Its oracle is about | Evidence tier | May be PASS? |
|---|---|---|---|
| CAP-01, 02, 04, 05, 06, 07, 08, 09, 13 | the gate's arithmetic and the admission paths, exercised through real DSH services | T1/T2 | **Yes** — measured |
| CAP-03 | a replacement admitted mid-wave, on a controlled local provider | T1/T2 | **Yes**, with the no-SLO limit stated |
| CAP-11 | a pause gating admission | T1 | **Yes for that half**; the reporting half is missing (§3) |
| CAP-10 | the product sustaining a top-up through a storm of completions | T2 | **No — FAIL** (§2), and its run is test-installed anyway (§4) |
| CAP-12 | the cost ledger recording an overrun | T1 | **Yes** — measured |

---

## 6. Reproduce

```sh
cd /d/DSH/work/dsh-native-daily

# The identity this evidence is filed under (expect 28/28 checks, MATCH)
python qualification/results/T1-spec/verify-identity.py

# The primary transcript (41 passed | 1 expected fail, ~5s, ONE file, ONE worker)
cd packages/dsh-daily-work
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/capacity.test.ts \
  --maxWorkers=1 --no-file-parallelism

# The V8 gap probes (3 passed | 1 expected fail, ~2s, ZERO children in 3 of 4 arms)
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/capacity-v8-probe.test.ts \
  --maxWorkers=1 --no-file-parallelism

# The refill timeline CAP-03 quotes (~7s)
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/scheduling.test.ts \
  --maxWorkers=1 --no-file-parallelism

# The composed-profile boot: ONE host, 19/19 checks, into V8's OWN results dir
cd /d/DSH/work/dsh-native-daily/qualification/results/V8-capacity
node run-v8-capacity-boot.mjs

# The G-SEAM-31 re-verification (the file is generated by the greps it records)
cat /d/DSH/work/dsh-native-daily/qualification/results/V8-capacity/create-run-callers.txt
```

**Prerequisite for the boot:** the home `D:/DSH/home/t10-capacity/profiles/daily`
must exist with the profile installed. Its `presets/daily-standard/agent.cordis.yml`
hashes to `16bc20e5…`, which is exactly `deployment.inputs.agent_preset_digest` —
so the preset this boot mounts is the identity's own preset, verified not assumed.
Its `cordis.patch.yml` hashes to `5b8b2a8e…`, exactly
`deployment.inputs.host_profile_digest`.

---

## 6. The evidence files, per case

All under `qualification/results/V8-capacity/`, all filed under identity
`0a0996f3…`. Each transcript is the verbatim `vitest` output of ONE file run with
`--maxWorkers=1 --no-file-parallelism`, ANSI codes intact, including the exit code.

| Case | Primary transcript(s) | Supporting |
|---|---|---|
| CAP-01 | `cap01-boundary.txt`, `cap01-n10-real.txt` | `prod-capacity.json` (real refusal at 30), `prod-capacity-report.json` |
| CAP-02 | `cap02-paths.txt`, `gap-probe.txt` (cold resume) | `capacity-tests.txt` |
| CAP-03 | `cap03-refill.txt` (the timeline), `cap01-n10-real.txt` | `scheduling-tests.txt` |
| CAP-04 | `cap04-cancel.txt`, `cap04-cancel-live.txt` | — |
| CAP-05 | `cap05-root-budget.txt`, `cap05-root.txt`, `cap05-root-classifier.txt` | — |
| CAP-06 | `cap06-no-filler.txt`, `cap06-no-filler-live.txt` | — |
| CAP-07 | `cap07-host-wide.txt` | — |
| CAP-08 | `cap08-target.txt` | — |
| CAP-09 | `gap-probe.txt` (`V8/CAP-09 measured: accepted=1 refused=2 …`) | `cap12-cost-overrun.txt` (the unknown-retention half) |
| CAP-10 | `gap-probe.txt` (`V8/CAP-10 measured: freedSlots=2 … admitted=3`), `cap10-storm-balanced.txt`, `cap10-coalesce.txt` | `capacity-tests.txt` (the same defect through three real children) |
| CAP-11 | `cap11-pause.txt`, `cap11-pause-service.txt` | — |
| CAP-12 | `cap12-cost-overrun.txt` (17 tests) | — |
| CAP-13 | `gap-probe.txt` (`V8/CAP-13 depth refusal:` and `V8/CAP-13 measured:`), `cap02-paths.txt` | — |

`capacity-tests.txt` is the whole `capacity.test.ts` file in one run
(`41 passed | 1 expected fail (42)`, exit 0) and is the shared transcript for the
cases whose individual runs are also listed. `scheduling-tests.txt` is the whole
`scheduling.test.ts` file (`9 passed (9)`, exit 0). `source-digests.txt` records
the sha256 of every source file this family's verdicts depend on, so a reader can
tell whether a later edit invalidates them. `create-run-callers.txt` is the
G-SEAM-31 re-verification. `run-v8-capacity-boot.mjs` is the driver that produced
the two `prod-capacity*` artifacts.

**The build.** `lib/` was built 2026-09-20 07:10; every capacity source it compiles
is older (`src/capacity.ts` 05:10, `src/host.ts` 05:10, `src/counting.ts` 04:xx).
The V8 probe file added here is run from `src/` through vitest's transform, so it
is measured against the current source; the `lib/` timestamp matters for the boot,
which loads the built bundle. Recorded because G-SEAM-29 was a stale-`lib/` false
finding.

---

## 7. What was not measured, stated rather than implied

- **No 30 real children.** Per the user's CPU constraint and T10's own decision,
  the cap boundary is reached with 29 arithmetic reservations plus ONE real
  creation call. The arithmetic is the evidence for the boundary; the real call is
  the evidence that the boundary binds. The cap's bindingness was NOT re-run at
  scale.
- **No live paid provider.** `UPG-07` stays BLOCKED_EXTERNAL — no authorized
  budget on this machine. The children here run on a scripted local adapter, so
  these gates prove MECHANICAL admission and refill, not a provider result.
- **No end-to-end product run of the N=10 arm.** Impossible by G-SEAM-31: no user
  action creates a run, so there is nothing to drive. Recorded as the reason
  CAP-10 is FAIL rather than being worked around.
- **The `it.fails` case in `capacity.test.ts` is still an OPEN DEFECT**, not a
  pass: `WorkService.drain`'s coalescing lets K concurrent drains over-admit when
  K exceeds the free slots (§2). Not owned by this family; reported as found.
- **The probe's own children are not cleanly reaped.** The composed-profile probe
  leaves its child to host shutdown and the harness SIGKILLs the host. The ledger
  is asserted back to its pre-boundary state, so no measurement is contaminated,
  but a reader should know the child is not disposed.
- **CAP-03 has no SLO to measure against.** None is frozen in this repository, so
  the refill latency is reported as a number rather than judged against a
  threshold. Calling it a PASS against an SLO would require inventing the SLO.
