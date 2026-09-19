# T10 — capacity: the gate table

**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`, base HEAD `d86e180`
**Pinned reference:** `D:\DSH\src\dsh-src` (read-only)
**Toolchain:** `node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run <file>` from
`packages/dsh-daily-work`, with `--maxWorkers=2 --no-file-parallelism`, one file at a time.

Every gate below was run. Nothing is reported PASS from reading. Where a claim is a
*read of source* rather than a *measurement*, it is marked `[read]` and is not counted
as evidence.

---

## 1. The failing test that was re-dispatched to me

`src/capacity.test.ts > CAP-01 > folds a task slot into its live child rather than
double-counting it` failed with `expected function to throw an error, but it didn't`.

**Verdict: the EXPECTATION was wrong. The guard is correct. `capacity.ts` was NOT changed.**

The case builds a gate at capacity 2, reserves task `t1` for child `c1`, materializes
`c1`, re-reserves `t2` as `unknown_quarantined` for the SAME `c1`, and asserts
`occupied === 1` — which is the property the case exists for, and it held. It then
asserted that a new child `c-new` must be **refused**, with the stated justification
"the live child is occupying the single remaining slot".

That justification is arithmetically false: capacity 2 with **one** executor leaves
**one free slot**, so `c-new` is admitted. Measured directly on the unfixed revision,
over the real class:

```
after reserveTask(t1,starting,c1): liveChildren 0, unbacked 1, occupied 1
after reserveChild(c1)         : liveChildren 1, unbacked 0, occupied 1
after reserveTask(t2,quar,c1)  : liveChildren 1, unbacked 0, occupied 1, quarantined 1
reserveChild(c-new)            : ADMITTED -> liveChildren 2, occupied 2   (no throw)
capacity = 2
```

The line was left over from the PREVIOUS, incorrect count: the comment two lines above
records that an earlier revision asserted `2` here and was corrected to `1`, and the
`toThrow` line still assumed the old total of 2. It was asserting a refusal that the
corrected count does not produce.

**What I did instead of deleting it.** The case keeps the fold property and gains the
refusal the removed line was reaching for, stated at the capacity where it is actually
true — a 1-slot gate with the single executor live and quarantined DOES refuse a new
child, which is the "quarantine still occupies" half. The change is in
`src/capacity.test.ts` only; `src/capacity.ts` is untouched (digest recorded in
`source-digests.txt`).

**Why this is not a symptom of G-SEAM-31.** The coordinator asked me to check whether
the missing throw was a symptom of the run-creation gap. It is not. This case is a pure
in-memory exercise of `ChildAdmissionGate` — no service, no run, no child — and the
arithmetic is wrong independent of any wiring. The two findings are unrelated; the
unreachability of `createRun` is measured separately in §4.

---

## 2. Gate table

| Gate | Assertion | Measurement command | Result |
|---|---|---|---|
| **T10-CAP-01** | The hard capacity is the deployment constant 30, and the admit/refuse boundary at target 10 is: 10 occupied is the target, 30 is the cap, the 31st is the first refusal, and headroom above the target is 20 | `vitest run src/capacity.test.ts -t "the ADMIT/REFUSE BOUNDARY"` | **PASS** |
| **T10-CAP-02** | The root is excluded by the CLASSIFIER, not by mount order: a root created AFTER the guard is mounted takes no slot, `isSessionBackedChild(root) === false`, and a real child in the same rig does take one | `vitest run src/capacity.test.ts -t "the root EXCLUSION is the classifier"` | **PASS** |
| **T10-CAP-03** | Real N=10: ten distinct children in flight through the real continuable seam, each parked in its own provider call; the 11th refused; the root holds no slot; highWater never above 10 | `vitest run src/capacity.test.ts -t "REAL N=10: ten children in flight"` | **PASS** |
| **T10-CAP-04** | Rolling refill at N=10: three rounds, each completing exactly ONE child while NINE stay active; each round admits exactly ONE replacement and returns to exactly ten; 13 distinct children ran while the host never held more than 10 | `vitest run src/capacity.test.ts -t "REAL N=10 ROLLING REFILL"` | **PASS** |
| **T10-CAP-05** | The root keeps its own budget: while ten children are in flight the root reaches its OWN provider call, takes no child slot, is not among the ten, and retains its full reserve (a greedy child admission that would eat it is refused) | `vitest run src/capacity.test.ts -t "the ROOT keeps its own inference budget"` | **PASS** |
| **T10-CAP-06** | The fold: a task slot whose child is live is counted ONCE, including when quarantined; a quarantined executor with no live child still occupies | `vitest run src/capacity.test.ts -t "folds a task slot"` | **PASS** (was the failing case) |
| **T10-PROD-01** | On a REAL composed profile boot: the daily-work service is mounted, its ledger limit is 30, and a real child created through the model-facing seam moves the ledger 0 → 1 (the guard is LIVE with no run in existence) | `node qualification/results/T10-capacity/run-prod-capacity.mjs` | **PASS** |
| **T10-PROD-02** | On the same boot: with the ledger positioned at 30, a genuine `startContinuable` call through the composed `spawn` provider is REFUSED with `hard capacity is 30`, and occupancy never exceeds 30 | same command | **PASS** |
| **T10-PROD-03** | On the same boot: the composed `subagent` row carries `maxActiveSubagents: 10, maxDepth: 1`, read from the LIVE loader entries (not the patch file) | same command | **PASS** |
| **T10-PROD-04** | G-SEAM-31: the model-facing `work` tool cannot find a run, because nothing in the product creates one | same command | **PASS** (the defect REPRODUCES) |
| **T10-PROD-05** | G-SEAM-19 is closed IN THIS PRODUCT: the upstream one-shot hole (no capacity check on `SubagentRuntime.start`) is caught anyway by the `agent/created` guard — a real one-shot child TAKES a host slot on the composed profile | same command | **PASS** |
| **T10-ENV-01** | G-SEAM-19's two upstream facts are still true of the pinned checkout: the one-shot path has no `maxActiveSubagents` check, and the pool is a per-root `WeakMap` | `sed`/`grep` on `D:\DSH\src\dsh-src` (commands in §6) | **PASS** `[read]` |
| **T10-BUILD-01** | The tree typechecks | `node .../typescript/bin/tsc -p tsconfig.check.json --noEmit` | **PASS** (exit 0) |
| **T10-PROD-06** | The composed profile can EXERCISE the N=10 rolling top-up from a user action | — | **FAIL — see §4** |
| **T10-UPG-07** | 30 non-empty children driven by a live paid provider | — | **BLOCKED_EXTERNAL** — no authorized provider budget on this machine (unchanged from the prior task's record) |

Raw evidence: `capacity-tests.txt` (the whole file's run), `prod-capacity.json` +
`prod-capacity-report.json` (the boot), `create-run-callers.txt`, `source-digests.txt`.

---

## 3. The capacity arithmetic, as measurement

Measured on the deployment's own numbers: **target N = 10**, **hard cap = 30**,
**root excluded**.

| Quantity | Value | Where it comes from |
|---|---|---|
| `HARD_CHILD_CAPACITY` | 30 | `capacity.ts:89`; asserted `T10-CAP-01`, and read LIVE from a composed boot as `gateLimit: 30` (`T10-PROD-01`) |
| Sustained target N | 10 | `cordis.patch.yml` `targetChildren: 10`; the composed `subagent` row's `maxActiveSubagents: 10` read from the live loader (`T10-PROD-03`) |
| Root counted in N? | No | `isSessionBackedChild` returns false for a root; `T10-CAP-02` asserts it both directions, `T10-CAP-05` asserts it live |
| Occupancy at the target | 10 | `T10-CAP-03`, measured on real children |
| First refusal | the 11th | `T10-CAP-03` — refused at the target, `capacityDeficit` 0 |
| Occupancy at the cap | 30 | `T10-CAP-01` (arithmetic), `T10-PROD-02` (real creation call refused) |
| First refusal at the cap | the 31st | `T10-CAP-01`; the refusal message is `the host already holds 30 children and the hard capacity is 30` |
| Headroom above the target | 20 | `T10-CAP-01`: `limit - N = 30 - 10` |
| `highWater` | never > 30 | asserted at every stage of `T10-CAP-01`, `T10-CAP-03`, `T10-PROD-02` |

**The refill behaviour, measured.** At N=10, each round: one child completes → the other
nine stay provably active and hold their slots → the confirmed transition frees exactly
one slot (`capacityDeficit === 1`) → exactly one replacement is admitted and reaches its
own model request → the count returns to exactly 10, `highWater` stays 10,
`capacityDeficit` returns to 0. Three rounds, 13 distinct children total, peak occupancy
10. This is what distinguishes rolling from wave: the replacement is admitted while nine
siblings are still running, which a wave scheduler cannot produce.

**Root's separate budget, measured.** With ten children in flight, the root issues a
turn of its own and its provider call is observed with `sessionId === root.id`; the
child ledger stays at 10, `hasChild(root.id) === false`, and `rootAvailable === 500`
while `childCeiling === 9500`. A child admission of 9,501 against a 10,000 ceiling is
refused for budget, leaving the root's reserve untouched.

---

## 4. Is the hard cap of 30 enforced in a production path?

**Yes — and this is the opposite of what I expected, so the instrument matters.**

`WorkService`'s CONSTRUCTOR calls `mountChildAdmissionGuard`, and `host-plugin.ts`
constructs the service during boot. The guard is therefore mounted on `agent/created`
**before any run exists**, and it is not gated on a run. Measured on a real composed
profile boot (`T10-PROD-01`, `T10-PROD-02`):

- `gateLimit: 30` read from the live service;
- a real child through the model-facing seam moved the ledger 0 → 1 — so a listener
  really answered, on the composed profile, with no run;
- with the ledger at 30, a genuine `startContinuable` was **refused** with
  `hard capacity is 30`, and occupancy never exceeded 30.

**So the enforcement is NOT test-only.** It is a real production path: the model's
`subagent` tool (preset `backgroundMode: continuable`) reaches `startContinuable` →
`agent/created` → the guard. That is a genuine closure of the "mechanism implemented,
tested, correct, nothing calls it" defect class **for the cap itself**.

Two honest limits on that claim:

1. **The `createRun`/drain/refill half IS unreachable.** See §5. The cap binds; the
   *managed run that the cap governs* cannot be started by a user action.
2. **G-SEAM-19 is closed only for in-process children.** The guard counts children
   materialized in THIS host process. An out-of-process provider (`acp`, `codex`,
   `claude-code`, `dsh-sdk`) publishes no local Agent and consumes no local slot; that
   capacity belongs to the other runtime. `capacity.ts:69-73` states this itself, and it
   is a real limit rather than a defect.

**G-SEAM-19 re-verified** `[read]` against the pinned checkout: `SubagentRuntime.start`
(`packages/subagent/subagent/src/index.ts:591-598`) runs `expectProvider` →
`assertCapabilities` → `assertSubagentMaxDepth` → `provider.start(resolved)` with no
capacity check, and the pool is `rootPools = new WeakMap<Agent, ActivationPool>()`
(`continuation-activation.ts:180`). Both facts are **still true upstream**. The gap is
closed in THIS product because every in-process child funnels through `agent/created`
regardless of which creation path it took — measured as `T10-PROD-05`, not argued.

---

## 5. The claim that must NOT be marked met on the strength of §3

**The mandatory N=10 rolling top-up is NOT reachable from the composed profile, because
nothing in the product creates a run.**

Re-verified myself, not taken on report:

```
$ grep -rn "createRun" src/ cordis.patch.yml profiles/ qualification/runners/   # minus *.test.ts
packages/dsh-daily-work/src/durability-runner.ts:63:  await service.createRun({     <-- the ONLY call
... every other hit is a doc comment or a probe that reads the method's existence
```

`durability-runner.ts` is a hand-run CLI and is itself in no production import graph.
The model-facing `work` tool resolves the run FIRST and throws
(`src/tools.ts:130-133`): *"this session has no active run; a run is created by user
authorization"*. Measured on the composed profile as `T10-PROD-04`: the `work` tool is
present in the preset (27 agent-keyed tools) and returns a STRUCTURED error with that
exact message. The tool's action enum is `status | submit | finish` — there is no create
action.

**So:**
- (a) **The capacity/refill ARITHMETIC is correct and bounded — PASS**, measured at the
  deployment's own numbers in §3.
- (b) **The COMPOSED PROFILE can exercise it — FAIL**, with the reason above. Gate
  `T10-PROD-06`.

Do **not** read §3 as the mandatory requirement being met. Every N=10 case in §3 creates
its run by calling `service.createRun(...)` **directly**, which is a TEST-INSTALLED entry
point — the same weaker-oracle shape as a test-installed launch port. The comment block
above the T10 describe in `capacity.test.ts` says so in the file itself.

**A legitimate seam, if the coordinator wants one** (I did not add a caller, and I am not
proposing to invent one): the model-facing `work` tool is the natural place for a
user-authorized `open` action, because the tool's own error message names "user
authorization" as the precondition and the tool already carries the calling Agent. The
`subagent` tool is *not* a candidate — it creates children, not runs. I found no existing
UI action, settings writer or session hook that creates a run. `dsh`'s `session/created`
event (`packages/core/session/src/index.ts:50`) is available as a hook point, but wiring
a run to every session would fabricate the authorization edge rather than implement it.

---

## 6. Reproduce

```sh
cd /d/DSH/work/dsh-native-daily

# Gates T10-CAP-01..06 (one file, bounded workers)
cd packages/dsh-daily-work
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/capacity.test.ts \
  --maxWorkers=2 --no-file-parallelism

# Gate T10-BUILD-01
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json --noEmit

# Gates T10-PROD-01..05: a REAL profile boot in T10's own home
cd /d/DSH/work/dsh-native-daily
mkdir -p D:/DSH/home/t10-capacity/profiles
cp -r profiles/daily-candidate D:/DSH/home/t10-capacity/profiles/daily
cd D:/DSH/home/t10-capacity/profiles/daily
DSH_HOME='D:\DSH\home\t10-capacity' node D:/DSH/src/dsh-src/apps/cli/lib/bin.js \
  plugin --profile daily install
cd D:/DSH/work/dsh-native-daily/qualification/results/T10-capacity
node run-prod-capacity.mjs          # expect 17/17, portReleased true

# Gate T10-ENV-01: G-SEAM-19 in the pinned checkout
sed -n '591,600p' D:/DSH/src/dsh-src/packages/subagent/subagent/src/index.ts
grep -n 'rootPools = new WeakMap' \
  D:/DSH/src/dsh-src/packages/subagent/subagent/src/continuation-activation.ts
```

---

## 7. What I did not measure, stated rather than implied

- **No live paid provider.** `UPG-07` (30 non-empty children on a real frontier provider)
  stays BLOCKED_EXTERNAL: no authorized budget. The children here run on a scripted local
  adapter, so the gates prove MECHANICAL admission and refill, not a provider result.
- **No 30 real children.** Per the user's constraint the cap boundary is reached with 29
  arithmetic reservations plus ONE real creation call; the arithmetic is the evidence for
  the boundary, and the real call is the evidence that the boundary binds.
- **The two-roots-over-30 arm is not re-run on a composed profile.** It is measured in
  the unit suite (`CAP-07`), where the per-family pool is raised to 64 so a refusal can
  only come from the host-wide ledger. The composed profile sets the pool and the target
  both to 10, so a refusal there would be over-determined.
- **The `it.fails` case in `capacity.test.ts` is still an OPEN DEFECT**, not a pass:
  `WorkService.drain`'s coalescing lets K concurrent drains over-admit when K exceeds the
  free slots. It is annotated in the file and is not mine to fix (`host.ts` is shared).
- **The probe's own child is not disposed** by the probe: it is left to host shutdown, and
  the host is SIGKILLed by the harness. The ledger is asserted back to its pre-boundary
  state, so no measurement below it is contaminated, but a reader should know the child
  is not cleanly reaped.
