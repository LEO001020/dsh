# P15 STEP 1 — inventory of stale claims in the public `README.md`

Measured at `2e1b2c2d3657407ce7ac621b07b3307d3edd8df4` (worktree
`D:\DSH\work\wt-p15`, branch `wt/p15`), working tree clean apart from the
writer's own untracked `.writer-provision.json`.

This is the reading step. It exists so that the README rewrite is a set of
decisions rather than a set of edits: every claim below is classified as either
**ALREADY-FALSE** (fixed in a wave that is already merged and pushed, so
correcting it cannot describe an unmerged future) or **THIS-WAVE** (a writer in
round 3 is changing the thing it describes, so P15 must not write its outcome).

Line numbers are from `README.md` at the commit above.

---

## A. The two headline claims V5 §16 names explicitly

| # | README line | claim as written | classification | evidence that falsifies it |
|---|---|---|---|---|
| A1 | 44-48, 87, 271-275 | "**No user action creates a run** (`G-SEAM-31`) … `WorkService.createRun` has no production caller, so the model-facing `work` tool throws `this session has no active run`" | **ALREADY-FALSE** — wave R4, merged and pushed | `qualification/results/R4-authorization/report-after.json` — 33 checks, `passed: 33, failed: 0`. The check `"the /work command IS registered in the agent-scoped view"` returns `names=["compact","export","feedback","goal","plan","work"]`, and `"A DURABLE RUN EXISTS after /work start 10"` returns a run record whose `authorizationRef` names `kind=human-command … commandName=work commandArgs=start 10`. Source: `packages/dsh-daily-work/src/command-work.ts` (module header states it is the missing entry point), mounted at `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml:384` (`- id: daily-work-command`). GAPS row `G-SEAM-31` reads **RESOLVED**. Fix commit `1ea7e89`, verified an ancestor of HEAD. |
| A2 | 49-54, 88, 276-282 | "**The Python cell cannot reach a DSH tool** (`G-SEAM-34`) … `new BridgeServer` has zero production call sites … today the model's Python has no tool access at all" | **ALREADY-FALSE** — wave R5, merged and pushed | `qualification/results/R5-bridge/composition-tier.json`: `bridgePresentAfterBoot: true`, `bridgeCreatedByProduction: true`, `bridgeEndpointPort: 9132`, `kernelLifecycle: "READY"`, `toolCallOutcome: "ok"`, `cellPrinted` contains `DSH_BOUND=True` and `CELL_VALUE={"marker":"R5-COMPOSITION",…}`, `ledgerDurable: true`, `ledgerDispositions[0].disposition: "settled"`. Source: `packages/dsh-ipython/src/kernel-plugin.ts:493` (`const bridge = new BridgeServer({`). GAPS row `G-SEAM-34` reads **RESOLVED**. Fix commit `85bc132`, verified an ancestor of HEAD. |

Note on A2's port number: `qualification/results/R5-bridge/RESULTS.md` narrates
port **4191** while the archived `composition-tier.json` records **9132**. Both
are real runs of the same instrument (the harness picks a free port); the JSON is
the archived artifact and the number a reader should cite. The README currently
cites neither.

## B. Other ALREADY-FALSE claims — same class, not named by V5

| # | README line | claim as written | evidence that falsifies it |
|---|---|---|---|
| B1 | 88-89, 306-308 | "`sandboxPolicy.defaultMode` is **`workspace-write`**, not `danger-full-access` (`G-SEAM-33`) … the now-mounted `daily-no-sandbox-contract` row detects this on every boot: it runs 8 deployment checks and its two failures are exactly this and the PTC mode" | `profiles/daily-candidate/cordis.patch.yml:607-610` is `- id: sandbox-policy` / `config:` / `mode: danger-full-access`. `qualification/results/R1-trusted-local/composition-after.json` contains `"mode": "danger-full-access"` and contains the string `workspace-write` **zero** times. GAPS `G-SEAM-33` reads **RESOLVED**; fix commit `e465a31`, an ancestor of HEAD. |
| B2 | 311 | "A page cursor is refused across a different revision but not across a different store (`G-SEAM-41`)" | GAPS `G-SEAM-41` reads **RESOLVED**: `PageCursor.storeRealmId` with `CursorAuthority.assertRealm` (`packages/dsh-daily-work/src/artifacts.ts:1390,1513`), called from the paging path at `:1755`; evidence `qualification/results/R7-cursor-realm/` (6 tracked files). |
| B3 | 313-315 | "Two of the six observation-gap stages have no producer at all (`G-SEAM-40`)" | GAPS `G-SEAM-40` reads **RESOLVED (by redefinition)** — the vocabulary was removed rather than producers invented; descriptor schema v1→v2; evidence `qualification/results/R8-taxonomy-split/`. |
| B4 | 316-318 | "Concurrent `drain` callers over-admit past the target, and `capacityDeficit` reads 0 (`G-SEAM-45`), so the overshoot is invisible to the reader that exists to catch it" | GAPS `G-SEAM-45` reads **RESOLVED**: the coalescer is gone, replaced by a per-run leader with a generation/dirty loop (`packages/dsh-daily-work/src/host.ts:1955-2032`); evidence `qualification/results/S9-cap10/` (23 tracked files); fix commit `89ac8bd`, an ancestor of HEAD. |
| B5 | 62, 67, 76, 84 | deployment identity given as `0a0996f3…` | `compatibility.lock.json` → `deployment.identity` is `533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb`. The lock's own `identity_history` entry for `533c8cb0…` states the consequence: every verdict bound to `0a0996f3…` "is now STALE as evidence for THIS identity", including all 109 filed cases. |
| B6 | 66-69, 81-93 | "**109 cases, all filed: 95 PASS, 13 FAIL, 1 BLOCKED_EXTERNAL, 0 NOT_RUN**, under deployment identity `0a0996f3…`" presented as the current state, with a table naming `G-SEAM-31`, `G-SEAM-34`, `G-SEAM-33` as the three reasons a user cannot use this | The tally is still what the file says (measured: 109 cases, `PASS=95, FAIL=13, BLOCKED_EXTERNAL=1`), but all three defects in the table are RESOLVED (A1, A2, B1) and the identity is superseded (B5). The block is history for `0a0996f3…`, not a description of the current candidate. |
| B7 | 78 | "All four are green." (the four commands at lines 71-76) | Measured at this commit: `python qualification/runners/verify-spec.py` → **exit 1**, `verify-spec: 317 problem(s)`, every one of them `evidence was filed under identity 0a0996f3944b5528... but the lock's identity is 533c8cb08b2ccd7f...`. `python helpers/doctor.py` → **exit 1**, `host_profile_digest is STALE: pinned 0e8e370e06375ad4... but profiles/daily-candidate/cordis.patch.yml hashes to 4e3aa20cbc23b8ce...`. Only two are green: `python qualification/results/T1-spec/verify-identity.py` → exit 0, "all 30 checks passed". `python qualification/runners/build-gates.py` was not run (it regenerates a report; not a read-only check). See "NEW FINDING" below. |
| B8 | 137, 147-154 | "`packages/dsh-daily-work` exports **eleven** entry points", then names five plus "the other six" | Measured: **13** keys in `packages/dsh-daily-work/package.json` `exports` (12 entry points plus `./package.json`). The README's list omits `./command` — which is A1's own fix — and `./no-sandbox-contract`. The README already instructs a reader to count with `python -c …` rather than trust prose; the prose is the thing that is stale. |
| B9 | 156-160 | "`packages/dsh-ipython` exports `host` … `tool` … `kernel`, `plugin` and `protocol`" (five named) | Measured: **6** keys, the five named plus `./package.json`. Minor, but it is a count in prose. |
| B10 | 162-171 | "`qualification/results/R3-unwired/import-graph.txt` is the current import graph, re-run at **78** `src/` files / 31 non-test modules: 25 reachable, 6 unreachable" | The artifact it cites says `TOTAL src modules: 77  non-test: 31` — so "78" is a transcription error against its own source. The tree has since grown: `packages/dsh-daily-work/src/*.ts` is now **95** files, **39** non-test. The artifact is also older than `./command`: its export-root list has ten roots and does not include `./command`, so the graph predates A1's fix. |
| B11 | 359-367 | "Against the new 112-case spec the state is simpler and worse: all 112 cases are `NOT_RUN` … because the architecture they describe is not built" | The 112-case count is right (measured: 112, all `NOT_RUN`), but the stated *reason* is stale: the architecture those cases describe is now largely built (persistent IPython, the native bridge, the capacity guard). "Not built" was true when written and is not true of current code. |
| B12 | 300-308 | "The deployment is not confined, and **one seam still says otherwise**" | The execution plane is still unconfined (that half is true), but the seam no longer says otherwise: B1. |

## C. THIS-WAVE claims — P15 must not write their outcome

These are not stale claims; they are claims about things a round-3 writer is
changing right now. The merge has not happened and P15 cannot measure it.

| # | README line | claim | owning writer | why P15 leaves it |
|---|---|---|---|---|
| C1 | 34-39, 231, 262-268 | tool counts: "**27 tools**", "a real Session … reports **28** tools", "27 agent-keyed tools" | **P6** (tool surface / preset) | The catalog is the exact thing P6 is editing. Any number P15 writes would be true of P15's worktree and false of the merged tree. |
| C2 | 147-149 | "The other six are newer and are mounted by the bundle patch: `data-host` and `data-service` (the observation/artifact plane) …" | **P4** (`dsh.data` routing) | `dsh.data` reachability is P4's slice. The README's own text says the plane exists; whether it is model-reachable is P4's to state. |
| C3 | 44-48, 271-275 | "the **mandatory** N=10 rolling top-up cannot be exercised on the composed profile" | **P5** (durable READY queue, completion-driven refill) | The refill mechanism is P5's slice. The A1 correction removes the *authorization* half of this sentence; the *rolling* half belongs to P5. |
| C4 | 56-61 | "Also absent: … an N control in a UI" | **P7** (Work UI / default-target semantics) | UI target semantics are P7's slice. |
| C5 | 18-25 (the clone block) | the Windows clone caveat | **P15** (this slice) | P15 owns it; see STEP 3. |
| C6 | 192-199 | "Test count: 1084 collected across 47 files … at commit `a1d6e6d`" | none — but unverifiable by P15 cheaply | It is already labelled by commit and hedged as a collection count, which is what V5 §16 asks for. P15 will keep it labelled and not re-measure it (running `vitest list` is a suite-scale action the brief forbids). |

## D. NEW FINDING (outside P15's slice — reported, not fixed here)

`qualification/runners/verify-spec.py` exits **1** and `helpers/doctor.py` exits
**1** at the published HEAD, while `README.md:78` says all four named commands
are green.

- `verify-spec.py` → `317 problem(s)`, all of the form `evidence was filed under
  identity 0a0996f3944b5528... but the lock's identity is 533c8cb08b2ccd7f...`.
  This is the intended consequence of the round-2 identity move (the lock's own
  `consequence` field says exactly this), but the *validator* treats it as a
  failure, so the command a reader is told to run to check the spec now fails.
- `doctor.py` → `host_profile_digest is STALE: pinned 0e8e370e… but
  profiles/daily-candidate/cordis.patch.yml hashes to 4e3aa20c…`. The profile
  patch gained a row after the identity was last derived (`8941ad5 S1: offer
  only our single mode`, an ancestor of HEAD), and the lock was not re-derived.

Both are recorded in `qualification/results/P15-status/STATUS-MEASUREMENT.md`.
P15 does **not** re-derive the identity and does **not** edit the validator:
`compatibility.lock.json` is excluded from P15's file ownership, and re-deriving
is a decision with a recorded procedure (`helpers/rederive-identity.py`, "A MOVE
IS NOT AUTOMATICALLY A CORRECTION") that belongs to the delivery owner.

Consequence for this slice: the README must not claim those commands are green.
It states what each one is for and reports the measured exit codes with the
reason, which is the honest form of the same sentence.
