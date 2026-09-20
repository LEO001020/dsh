# DSH Native Daily — adversarial audit dossier

**Prepared for:** independent audit (GPT-Pro class review)
**Prepared by:** the coordinating agent of the round-3 closure
**Date:** 2026-09-21
**Subject artifact:** `https://github.com/LEO001020/dsh` @ `5258d127c275fdd70e25125c6b9126031a5a39a0`
**Document status:** every number below was re-measured for this document unless explicitly labelled otherwise. Nothing is quoted from memory. Where a claim rests on a prior writer's artifact, the artifact path is given so a reviewer can re-derive it.

---

## 0. How to read this document

Three distinct questions are often collapsed into "is DSH done?", and conflating them is the main way a reader would be misled:

| question | answer | where |
|---|---|---|
| Does the **product** work for a user? | partially — see §3 and §5 | §3, §5 |
| Is the **qualification** complete? | **no** — `NOT_READY`, 4 mandatory FAILs | §1 |
| Is the **evidence self-consistent**? | mostly — one check fails at 315 problems, which is a work list not a defect list | §2.4 |

A reader who wants the single most important fact: **the release gate says `NOT_READY` with one blocker, 4 mandatory cases failed, and three of those four are recorded non-defects rather than unfixed work.** The fourth (IPY-13) fails on a word.

---

## 1. The release gate, in full

Command: `python qualification/runners/release-gate.py`
Verdict line: `RELEASE=NOT_READY blockers=1 candidate=152e5c45c4aef97b`

| # | check | result | detail |
|---|---|---|---|
| 1 | verify-spec passes | **FAIL** | 315 problem(s) — *reported, appends no blocker; see §2.4* |
| 2 | identity is fresh | ok | recorded `152e5c45c4aef97b` == recomputed |
| 3 | no FAIL | **FAIL** | 4: `CMP-04`, `IPY-13`, `REC-09`, `REC-10` |
| 4 | no FLAKY | ok | none |
| 5 | no NOT_RUN among mandatory | ok | none |
| 6 | no INVALIDATED | ok | none |
| 7 | no stale evidence | ok | none |
| 8 | only allowlisted BLOCKED_EXTERNAL | ok | none unauthorized |
| 9 | post-integration assembled-product evidence | ok | 3 of 66 assembled-product PASS cases carry evidence at the current identity |

Status counts: `PASS=104, FAIL=4, BLOCKED_EXTERNAL=1` over 109 cases.

**Check 9 deserves a precise reading, because "ok" overstates what it establishes.** The check passes if **at least one** assembled-product PASS case carries current-identity evidence. Measured: exactly **four** cases in the whole spec carry any current-identity evidence — `CMP-02` (PASS), `BR-07` (PASS), `CAP-10` (PASS) and `IPY-13` (FAIL) — so the check's `3 of 66` counts three PASSes. The other **101 PASS verdicts are bound to the superseded identity `0a0996f3`** and are therefore historical evidence, not evidence for the artifact as published (§2.1).

**And one inconsistency the audit should catch:** the `IPY-15` fix (§3.2) is in the published tree and its verdict reads PASS, but **its evidence entry is not stamped at the current identity** — so IPY-15 is one of the 101. The fix is real and measured; the *stamp* is behind. I record this rather than re-stamp it, for the reason in §2.1.

**Check 1 is deliberately not a blocker.** The gate's own header states the distinction: verify-spec "fails when a hash is wrong — a FILING error, fixable by re-filing evidence, and it says nothing about the product"; release-gate "fails when the candidate is not releasable". I verified this in source: `release-gate.py:230-234` appends a *check* and no blocker. **An auditor should treat the 315 as a work list, not a defect list** (§2.4 gives the exact decomposition).

---

## 2. Evidence architecture — where a reviewer should push hardest

### 2.1 The identity problem: two schemes coexist, and one is superseded

This is the single most confusing thing in the repository and the most likely source of a wrong audit conclusion.

| value | where it lives | what it is |
|---|---|---|
| `152e5c45c4aef97b…` | `compatibility.lock.json` → `deployment.identity` | the **superseded** scheme; the release gate's checks 2 and 9 compare against it |
| `0a0996f3944b5528…` | 314 evidence entries | a **real past identity**, present in the lock's own `identity_history` |
| `5146ee996bea2de8…` | 1 evidence entry (ID-06) | the **contract identity** from the generated BuildManifest (V5 §14) |
| `533c8cb0…`, `549732b5…`, `ece4037a…`, `73da4c62…`, `0ca14d4e…` | `identity_history` | five further historical values |

`helpers/rederive-identity.py` prints, at the top of **every** run:

> THIS IDENTITY IS SUPERSEDED. V5 section 14 split it into: `compatibility.expected.json` (requirements; no digest of any file in this repo); BuildManifest (generated; `RuntimeDeploymentIdentity = H(canonical manifest)`); Result/evidence files bind to `QualificationContractIdentity`.

So the repository contains **two identity regimes at once**, and the gate uses the older one. The generated manifests are:

| manifest | `runtime_deployment_identity` | `qualification_contract_identity` | cases |
|---|---|---|---|
| `trusted-local-v3.5146ee996bea` | `c969808e…` | `5146ee996bea…` | 110 |
| `trusted-local-v3.5bd8ee5b1809` | `0fe2d373…` | `5bd8ee5b1809…` | 110 |
| `trusted-local-v3.a091cb594902` | `c969808e…` | `a091cb594902…` | 110 |

Note the two manifests sharing `runtime_deployment_identity` `c969808e…` but differing in contract identity — consistent with the declared algorithm `H(RuntimeDeploymentIdentity + acceptance_definition_digest + release_runner_digests)`.

**What I did NOT do, and why it matters for the audit.** I did **not** re-stamp the 314 entries from `0a0996f3` to `152e5c45`. `0a0996f3` is in the lock's own history, so those entries are true statements about the artifact they measured at the time they measured it. Re-stamping would assert a measurement was taken against the current artifact when it was not. That is the forbidden move, and a gate that goes green by re-stamping is worse than a gate that stays red, because the red is at least true. The honest remedy is re-measurement, which is what nine cases received (§3).

**A concrete defect this exposes:** `compatibility.lock.json` → `promotion.decision_reason` is **stale in two ways**, both measured:
- it names two superseded identities (`0a0996f3…` and `533c8cb0…`) and never names the current `152e5c45…`;
- its `spec_sha256` is `e5b6a1d2481f39c5…`, which is the **frozen as-authored snapshot's** digest, while `spec_path` names the **live** spec whose digest is `635cb05a9a61b52f…`.

The block even contains a self-correction about a *previous* instance of the same defect class ("this record previously named the SUPERSEDED identity … which is the same defect class as the stale pins it describes"). It is a live example of the defect it warns about.

### 2.2 The spec family

| file | sha256 (16) | cases | statuses |
|---|---|---|---|
| `qualification/specs/acceptance-spec.json` | `2fe95835425eb98e` | 112 | all `NOT_RUN` |
| `qualification/specs/acceptance-spec.trusted-local-v1.json` | `635cb05a9a61b52f` | 109 | 104 PASS / 4 FAIL / 1 BLOCKED_EXTERNAL |
| `qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json` | `e5b6a1d2481f39c5` | 109 | all `NOT_RUN` |
| `qualification/specs/acceptance-spec.trusted-local-v2.definition.json` | `115aa092d0279c00` | 110 | no status field |

**Only the frozen snapshot and the 112-case spec are identity inputs.** I verified the live 109-case spec is not: `grep -c 'acceptance-spec.trusted-local-v1.json' helpers/rederive-identity.py` returns 0. That is why verdict re-measurement in this round did not move the identity.

### 2.3 The 109-case spec by tier

Tier legend is the spec's own: T0 pure function; T1 production services with a mock provider; T2 the actual built host/profile/preset, booted; T3 real subprocess kill and real disk recovery; T4 real OS boundary; T5 authorized live provider; T6 real coding/research task end to end.

| tier | total | PASS | FAIL | BLOCKED |
|---|---|---|---|---|
| T0 | 6 | 6 | 0 | 0 |
| T1 | 33 | 32 | 1 | 0 |
| T2 | 56 | 54 | 2 | 0 |
| T3 | 10 | 9 | 1 | 0 |
| T4 | 3 | 3 | 0 | 0 |
| T5 | 1 | 0 | 0 | 1 |

**T6 has zero cases.** The strongest tier the spec defines — "a real coding or research task end to end" — is empty, and the release gate's check 9 selects `{T2, T3, T4, T6}`, so T6 contributes nothing to its denominator of 66.

Evidence entries per layer: T0 18, T1 113, T2 158, T3 29, T4 6, T5 0. Total 324 entries; 314 carry `0a0996f3`, 6 carry `152e5c45`, 3 carry none, 1 carries `5146ee996bea`.

### 2.4 The 315 verify-spec problems, decomposed exactly

Predicted by arithmetic and confirmed: every evidence entry whose identity differs from the lock's current `152e5c45` is flagged.

| count | kind |
|---|---|
| 314 | identity stamp `0a0996f3944b5528…` — a **real past identity** in `identity_history` |
| 1 | identity stamp `5146ee996bea2de8…` — the contract identity, on `ID-06`'s new evidence |
| **315** | total |

**Zero digest mismatches. Zero missing files. Zero other kinds.** This is a clean decomposition: the 315 is entirely one filing-convention gap between two identity regimes.

### 2.5 The 112-case authority is a different case set

The user's audit package (`delivery/acceptance-spec.json`) is byte-identical to the repo's `qualification/specs/acceptance-spec.json`: 112 cases, all mandatory, all `NOT_RUN`, tiers `integration 72 / fault_injection 16 / security 16 / evaluation 8`, `hard_child_capacity: 30`, `target_range: [1,30]`, families `DEP IPY BRG DAT WEB HIS REC SEC CAP UI VER ECO RES UPG` × 8.

**The two specs cannot be joined on `id`.** The 109-case spec's families are `BR CAP CMP DATA FS ID IPY OBS REC RES VER` — only `CAP IPY REC RES VER` overlap, and even there the numbering was authored independently (`CAP-01..08` vs `CAP-01..13`). A family-level join would be a guess.

The per-case inventory is at `qualification/results/C9-coverage/COVERAGE.md`, produced by writer c9:

| tier | total | COVERED | PARTIAL | UNCOVERED | BLOCKED_EXTERNAL |
|---|---|---|---|---|---|
| integration | 72 | 57 | 9 | 3 | 3 |
| fault_injection | 16 | 6 | 8 | 2 | 0 |
| security | 16 | 11 | 4 | 0 | 1 |
| evaluation | 8 | 2 | 4 | 0 | 2 |
| **ALL** | **112** | **76** | **25** | **5** | **6** |

**Three qualifications c9 recorded, which matter more than the headline 76:**
1. Much of the evidence is measured at a **tier below its label**. Many strong results run real services with a **controlled model adapter** at the provider boundary. That is honest for a mechanical oracle but is **not** the same claim as "a real user action drove this on the shipped profile".
2. **COVERED means "an artifact establishes this oracle", not "the product is qualified".**
3. The reachability distinction is visible in specific rows: `REC-06/07/08` and `RES-04/06` are PARTIAL precisely because their mechanism lives in `kernel-lifecycle.ts`, which has no non-test importer.

c9 also **corrected a prior count**: `MAIN-112-status/STATUS.md` reported 92 cases "named" by an evidence file. That was a mechanical string match, which finds a case id inside a *what is NOT proven* list too. Reading the assertions gives 76.

The 6 BLOCKED_EXTERNAL split into two kinds: **four need a live provider budget the user does not have** (`IPY-08`, `ECO-07`, `ECO-08`, `UPG-07` — whose oracle states mock results do not substitute); **two need a provisioned world rather than budget** (`DEP-04` no SSH execution world mounted; `SEC-08` needs two read-permission domains, this deployment has one).

---

## 3. The 4 FAILs, and what happened to the other nine

### 3.1 The four that remain

| case | tier | why it is not a product defect |
|---|---|---|
| `CMP-04` | T2 | **spec self-contradiction, verified real.** Its oracle requires `toolCountAgentKey is 28` and `pwsh is present`; `CMP-13` requires `pwsh` ABSENT and PASSES on the same measurement. Writer c6 tested the alternative (a measurement artifact) three ways and refuted it: all 8 of 8 recorded 28-valued measurements carrying a name set include `pwsh`; no other key or cwd reproduces it; the existing control moved 27→28 by adding exactly `pwsh`. **The supersede option has already been exercised** — the v2 definition under decision D1 records CMP-04 as `rewritten` with `dropped_assertions: ["toolCountAgentKey is 28", "pwsh is present"]`. Superseding again would invalidate 109 verdicts a second time to fix a note. |
| `REC-09` | T3 | **the guard was DELETED, not left unwired** (G-SEAM-21). `recovery.ts` now exports only `RelaunchOutcome` and `relaunchPrepared`; its own comment records that it "used to also export a settlement guard: `WorkerSettlement`, `applyWorkerSettlement`, and a `RefusalLedger`". Two tests enforce the deletion (`durability-advanced.test.ts:867`, `upg-gates.test.ts:1820`). Quoted from GAPS: the guard's input "cannot be constructed on any production path (no production call site writes a terminal state; `unknown` has no production exit)". Wiring it would mean **manufacturing a caller to satisfy an oracle** — the anti-pattern this project records most. |
| `REC-10` | T1 | same deletion; this case asks for reachability of something that no longer exists. |
| `IPY-13` | T2 | **fails on a word.** The recorded defect is gone and the product's behaviour is arguably better than the oracle asks — but the oracle's literal requirement is `undecidable` and the product reports `known-late` with a true originating cell id. An oracle is not satisfied by a better outcome it did not anticipate. |

### 3.2 The nine that moved, each with its instrument

| case | recorded FAIL | measurement | independent check |
|---|---|---|---|
| `ID-06` | pinned checkout dirty | **CRLF artifact.** HEAD blob 7086 B pure LF; worktree file 7251 B pure CRLF; difference exactly 165 B = one per line. `git hash-object` == `git rev-parse HEAD:<path>`. `.gitattributes` says `eol=lf`; `core.autocrlf=true` is the host override | `check-source-plane.mjs` now exits 0: "source plane: CLEAN"; `build-manifest.py --check-expected`: "every requirement in compatibility.expected.json holds" |
| `ID-01` | 1 of 223 specifiers resolved outside `lib/` | **the boot measured a different checkout.** The offender's own recorded `parentURL` is `file:///D:/DSH/work/dsh-native-daily/...` — the main checkout, on branch `ipython-native`, which never received fix `bcc036e` (`git merge-base --is-ancestor bcc036e HEAD` → NO). Timing agrees: evidence committed 08:02, fix authored 10:10 | In the qualified tree `artifacts.ts:131` imports the public `@deepseek-ai/dsh-attachment`; `grep '^import.*attachment-local'` over built `lib/artifacts.js` returns nothing; `no-src-imports.test.ts` 5/5. Writer c4 reproduced with **0 offenders, 17/17**, plus a **negative control** (injected offender → FAIL with the worktree's own parent path) |
| `ID-05` | 475 non-test `as never` | **zero.** Two probes had independently written `apply(toolCtx as never)` — the same shape twice, the signal that a **seam** was missing. Added `IpythonToolMount` / `IpythonToolService` (a `Pick` of `KernelService` naming the four members `execute` reaches) and `registerIpythonTool`; `apply(ctx)` delegates | Deleting the casts surfaced **two real type errors** they had been hiding (`runCell` returning `Promise<unknown>` where `Promise<CellResult>` required; `ArmOutcome.result` typed `unknown`). Both fixed and now checked. `typecheck: PASS`, baseline 0 |
| `CMP-02` | sandbox row resolved `workspace-write` | **`danger-full-access`**, all three clauses, real boot | **negative control**: reverting the mode flips the same instrument to `STILL FAILS` with `ptcConfineDecision: WOULD CONFINDE` |
| `BR-07` | bridge route had no disposition vocabulary | vocabulary exists and is reachable; **the original probe, unmodified**, flips both vocabulary booleans while drain timing is unchanged (1514 ms) | 10/10 in the r5 product-bridge suite: `cancelled`, `abandoned-unstarted`, `handed-to-jobs` with `jobId: "job-77"` |
| `CAP-10` | `drain` overshot under a completion storm | **the same V8 probe arm** that measured the defect now reads `admitted=2 heldAgainstTarget3=3 deficitAfter=0` (was `admitted=3`) | Storm suite adds control (`admitted=6 held=6 overshoot=0`), N+2-against-N (`admitted=6 launches=12 highWater=6`), duplicate arm, sweep 3/5/10 of 10, all `overshoot=0`. 7/7 |
| `IPY-15` | dropped-frame counter had zero call sites | the loss was **worse than recorded**, and there were **two** loss paths: (a) a 4,456,448-byte background write after its cell settled raised inside the iopub pump, whose bare `except Exception` swallowed it — 4.4 MB gone, model told nothing; (b) the over-limit reply is reachable at the **shipped 256 KiB cap** — 200 × 64 KiB `display()` entries → a **13,118,726-byte** reply, so it is not a raised-cap-only curiosity | The refusal now reads `FRAME_TOO_LARGE: N frame(s) LOST; frame of … exceeds the limit; declared … bytes, limit … bytes; the cell ran and its result was not delivered` — it states that the bytes are **gone**, not merely that a bound was exceeded. `noteDroppedFrameDefinitionCount` 0→1; `transportDroppedFrames` declared on the host's `KernelStatus` type. **Mutation-tested**: reverting the reply to bare `str(exc)` turns the gate RED, then restored |
| `DATA-09` | two stages have no producer so the clause cannot hold | the recorded reasoning **conflated stimulus with oracle**. The real defect: `captureFile` forced the shortfall to 0, so a 400-byte file read with `length: 1000` reported `complete-within-request`, `gaps: []`, `isDeliverableAsComplete: true` while 600 bytes were absent | Before/after: `partial, native-acquisition/none, deliverable FALSE`. Control (range inside file) unchanged. New pin **falsified** against a reverted build (1 failed / 47 passed) |
| `DATA-11` | a cursor yielded pages from a foreign store | named arms already held; the **harm** was reachable because the identity memo stamped on `(size, mtimeMs)`, both attacker-settable. Adding `ctimeMs` closes it | Before-arm reproduces the **exact digest the audit archived** (`cc7321cc…`); after: `artifact-integrity-error`. Pin **falsified** (1 failed / 37 passed) |

---

## 4. THE TOOL SURFACE — measured, not read

This section was requested explicitly and is measured from a live boot, not from documentation.

### 4.1 The model's effective surface: **24 tools**

Measured by writer c6 through a real boot with a probe that **inserts no tool row** (`qualification/results/C6-spec/c6-verdict.json`, `ranAt 2026-09-20T15:24:08Z`, cwd `C:/`, `probeAddsToolRow: false`, `error: null`):

```
ask_user_question  create_goal  edit      exit_plan_mode  get_goal
glob               grep         interrupt_agent        ipython
job_kill           job_list     job_output             list_agents
present            read         read_image             send_message
skill              todo_write   update_goal            web_fetch
web_search         work         write
```

`toolCountAgentKey: 24`, `ipythonToolPresent: true`, `workToolPresent: true`, `error: null`. Reproduced across three arms with **identical results**: non-repo cwd (`D:/DSH/work/c6-foreign-cwd`), repo-root cwd (`D:/DSH/work/wt-c6`), and the default arm. `toolCountContextKey: 0` and `toolCountGlobalKey: 0` in every arm — the surface is agent-keyed, not context- or global-keyed.

### 4.2 The preset rows that produce it

From `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` — **35 rows**, parsed line by line:

**DISABLED unconditionally (9):**

| row | why |
|---|---|
| `tool-pwsh` | IPython is the model's only execution surface (commit `35c829d`) |
| `tool-subagent` | model-facing child creation removed (commit `d8b95cb`, P0.7) |
| `tool-subagent-fork` | same |
| `tool-subagent-codex` | same |
| `tool-subagent-claude-code` | same |
| `workflow-ptc` | disabled **in the same edit** as `tool-workflow` because `tool-workflow` injects it — disabling one alone would leave the other permanently pending |
| `tool-workflow` | same |
| `tool-ralph` | not part of this deployment's surface |
| `tool-plugin-manager` | the model may not manage plugins |

**ENABLED or conditionally enabled (26):** `persona`, `agent-instructions`, `tool-bash`, `tool-fs`, `tool-fs-search`, `tool-jobs`, `skill-filesystem`, `tool-skill`, `command-goal`, `tool-goal`, `planning`, `plan-mode`, `compaction`, `compaction-basic`, `command-compact`, `tool-result-pruner`, `delegation`, `tool-subagent-control`, `tool-subagent-list-agents`, `tool-ask-user`, `tool-todo`, `tool-web`, `present`, `daily-work-tools`, `daily-work-command`, `ipython-tool`.

### 4.3 One row is a **host-dependent expression**, and it resolves to DISABLED here

`tool-bash` carries `disabled: !!js process.platform === 'win32'`. On this host `process.platform` is `win32`, so **`tool-bash` is DISABLED**. Its shipped form enables it on non-Windows, which is why the row is kept declared rather than deleted.

**Auditor's note:** this is a real portability fact with a consequence — on a Linux host the surface would be **25 tools**, not 24, and `bash` would appear. The 24-tool figure is a statement about *this* host.

**The preset's own rationale for leaving it shipped is worth reading as a statement of method**, because it is the project's rule applied to itself:

> WHY `tool-bash` IS LEFT EXACTLY AS SHIPPED. Its shipped expression enables it on POSIX, and this deployment is Windows, so the row is inert here either way. Changing it would be a POSIX claim with no POSIX evidence behind it — the "claim you did not measure" failure this repository records as G-FIX-04.

So the asymmetry is deliberate: the row is **not** hard-disabled, because hard-disabling it would assert something about POSIX that this deployment has never measured. An auditor who thinks the row should be `disabled: true` unconditionally should also accept that it would then be an unmeasured POSIX claim.

**Also note what the shell row does NOT control.** The preset states that the `shell` **service** is unaffected by this row — it is provided by host-plane executor rows (`pwsh-sandbox`/`bash-sandbox`, mounted by `@deepseek-ai/dsh-base`), and the host rows that consume it (the terminal controller, the permission stack) keep resolving it. What the preset chooses is only whether the **AGENT** gets a model-facing shell tool. A reviewer reading "tool-bash disabled" as "no shell exists in the process" would be wrong.

### 4.4 Why 17 `tool-*` rows in the host dump read `disabled: true` while the surface has 24 tools

A live `--dump-config` shows all 17 host-plane `tool-*` rows as `disabled: true`. That is **not** a contradiction, and the preset's own comment states why:

> **editing `profiles/daily-candidate/cordis.patch.yml` cannot change the model's tool surface.** That patch owns the host plane (the roster, the subagent capacity override, the sandbox and approval rows). This file owns what the model sees.

The preset **re-declares** the rows with the disabled state it wants, and the preset is what the model reads. A reviewer who reads only the host-plane dump would conclude the surface is empty; a reviewer who reads only the preset would miss the host plane. **Both planes must be read.**

### 4.5 What is absent, and each absence is deliberate

| absent | mechanism | consequence |
|---|---|---|
| `pwsh`, `bash`, `shell`, `run_code` | disabled in the preset / host-dependent | **IPython is the model's only execution surface** |
| `subagent`, `subagent_fork`, `workflow` | four rows disabled (`d8b95cb`) | the model cannot create children directly; it goes through `work` |
| `terminal_*` (six tools) | `dsh-tool-terminal` is mounted by **no** shipped preset (G-SEAM-17, OPEN) | the human `terminalController` is never a model capability — which is the intended security property |
| any `data.*` tool | `dataToolNames` is `[]` (writer c3, measured) | a model **cannot** reach `data.pages` as a native tool; the data plane is reachable as a *service* but not as a *tool* |

**Two consequences an auditor should weigh:**
1. `ipython` being the only execution surface **raises the stakes** on the IPython bridge. G-SEAM-34 ("the IPython native-tool bridge is outside the transitive closure of every package entry point") is recorded as **RESOLVED** — `new BridgeServer(...)` is now constructed at `packages/dsh-ipython/src/kernel-plugin.ts`, and I verified end-to-end that a real cell calls a real DSH tool: `bridge-seam.test.ts` **17/17**, including "a cell calling `dsh.call` lands in the real ToolRuntime pipeline, and the value comes back" and "N nested calls produce N dispatches and N results, with no turn taken by the bridge".
2. `work` is present but **throws** without a run: measured `"this session has no active run; a run is created by user authorization"` (`runReachable: false`). G-SEAM-31 is recorded **RESOLVED** — `src/command-work.ts` registers `/work start [N]` as the human authorization path. So the model cannot start child work unilaterally; a human command creates the run. **This is a deliberate authority boundary, not a bug** — but it means the mandatory N=10 rolling top-up is not reachable by model action alone.

### 4.6 Capacity: measured binding in production

`qualification/results/T10-capacity/prod-capacity-report.json` — **17/17 checks, verdict PASS**, on a real boot:

- "the ledger limit is the deployment constant 30" → `30`
- "a real child was created through the model-facing seam" → `childId="e9e2931f-…" error=null`
- "THE GUARD IS LIVE: the ledger recorded the child (delta 0 → 1)"
- "**THE CAP IS BINDING IN PRODUCTION**: a real creation call was REFUSED at 30" → refusal text names the deployment constant
- "the refusal never raised occupancy above 30" → `occupied=30 highWater=30`
- "releasing the filler returns the ledger to its pre-boundary state"
- "**G-SEAM-19 CLOSED IN PRODUCT**: a one-shot child TAKES a host slot" → `started=true liveChildren=2`

**Still OPEN on this subject, stated rather than glossed (G-SEAM-19):** DSH's own pool is `rootPools = new WeakMap<Agent, ActivationPool>()` — **per-root, not host-wide**. The host bound is this project's `mountChildAdmissionGuard` ledger, not DSH's pool. Also `workflow-ptc`'s `startChild` passes no `maxDepth`, so it escapes the deployment **ceiling** even though it no longer escapes the **capacity** cap.

**G-SEAM-18 (OPEN):** `resolveChildDepth(parent, request.maxDepth)` treats the caller's value as an absolute cap, so `maxDepth: 99` **lifts** the deployment cap, and **an omitted `maxDepth` behaves like 99**. This project's own path is unaffected (`launch-port.ts` hard-codes `maxDepth: deps.maxDepth`), but the workflow/PTC path is.

---

## 5. The 41 strictly-OPEN GAPS items, classified

`docs/GAPS.md` holds 95 rows. Strictly counting only rows whose status cell **begins** with `OPEN` (excluding "was: OPEN" in resolved rows): **41 open**.

| count | kind | ids |
|---|---|---|
| 33 | PRODUCT / EVIDENCE GAP | 03 04 05 06 13 16 18 24 25 26 27 28 39 43 44 50 51 52 53 58 59 61 63 65 66 68 69 70 76 77 78 79 80 |
| 4 | UPSTREAM (DSH behaviour, not this deployment) | 07 12 22 23 |
| 1 | DESIGN CONSTRAINT (accepted) | 10 |
| 1 | PRODUCT GAP explicitly blocking a claim | 19 |
| 1 | DUPLICATE | 17 |
| 1 | SPEC DEFECT (not a product defect) | 46 |

**The most consequential of the 33**, with their mechanisms:

- **G-SEAM-44** — `kernel-lifecycle.ts` is itself unreachable, so **three RECOVERY cases that PASS are statements about a mechanism rather than about the product.** Measured by `import-graph.mjs`: **33 reachable / 8 unreachable** non-test modules in `dsh-daily-work`; the unreachable set includes `durability-runner.ts`, `effects.ts`, `kernel-lifecycle.ts`, `perf-metrics.ts`, `reconcile.ts`.
- **G-SEAM-80** — `environmentDigest` is a digest of a **PATH STRING**: `sha256(\`${pythonExecutable}\u0000${platform}\u0000${arch}\`).slice(0,16)`. Measured six ways through the real `KernelService.identityFor`: pointing `brokerScript` at a different file leaves the digest unchanged; `pythonw.exe` vs `python.exe` in one directory produces different digests for the same interpreter; `DSH_PYTHON` spelled with backslashes or uppercase hashes differently.
- **G-SEAM-79** — the SECOND Session in any process silently gets a **memory** bridge ledger, so durability loss is routine rather than conditional on storage failing.
- **G-SEAM-24** — the sandbox seam has **no network vocabulary**; the pinned checkout says so as a deliberate deferral.
- **G-SEAM-12** — the Windows sandbox is real but **write-only** with `enforcement: 'partial'`; the seam has no read or egress lever in its type.
- **G-SEAM-17** — `dsh-tool-terminal` (six `terminal_*` tools) is mounted by **no** shipped preset.
- **G-SEAM-43** — two different `epoch` fields are conflated by a careless read: the KERNEL epoch advances on kernel death and is reachable, while the RUN-RECORD epoch does **not** advance even after a real SIGKILL and re-adoption.

---

## 6. What cannot be established on this machine

Governing constraint, quoted from `compatibility.lock.json` → `runtime_authorization`:

```json
{ "scope": "LOCAL_IMPLEMENTATION_ONLY",
  "live_provider_budget_authorized": false,
  "budget_amount": null, "currency": null, "deadline": null,
  "restart_resume_authorized": false,
  "external_publication_authorized": false }
```

- **No paid model evaluation. No real 30-child provider run. No vendor benchmark.**
- **The largest real N measured is 10, on a scripted adapter.** The 30-cap boundary was reached with **29 arithmetic reservations + 1 real call**; the project's own capacity file warns that a reader "must not read '30 real children were refused' out of this file."
- `CAP-08` is the **only** authority case whose text names 30. `UPG-07` is the **only** one whose text requires an authorization this project does not hold.
- The allowlist mechanism (`release-gate.py:92`) is a list of **REASONS with CONDITIONS**, re-checked against the lock every run, not bare case ids. Writer c12 verified by non-mutating probe that an unlisted `BLOCKED_EXTERNAL` case fails check 8, and that flipping `live_provider_budget_authorized` to `true` in a temp lock makes the `IPY-08` entry **stop applying by itself**.

**Not a shortfall — the design.** `UPG-08` ("日用最终判决") requires exactly this: `NOT_READY`, with the specific reproduction and external blocker reported.

---

## 7. Environment and reproducibility

| item | value |
|---|---|
| HEAD | `5258d127c275fdd70e25125c6b9126031a5a39a0` |
| branch | `cand-round3` |
| tree object | `8c4fb3e1660879e0362a49afc9637c2a3be550dd` |
| commits / files | 597 / 1980 |
| tracked bytes | 25.1 MiB |
| remote | `refs/heads/master` == same SHA, verified by independent `git ls-remote` |
| push type | **fast-forward** `2e1b2c2..5258d12`, not a force-push |
| pinned checkout | `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`, `git status --porcelain` **empty** |
| toolchain | Node v24.18.0, Python 3.14.3, TypeScript 6.0.3 (from the pinned checkout's `node_modules`) |
| packages | `dsh-daily-work` 41 prod + 61 test `.ts`; `dsh-ipython` 28 prod + 21 test `.ts`, 2 `.py` |

**Two reproducibility traps a reviewer must know:**

1. **`npx tsc` is a decoy stub on this machine.** It prints "This is not the tsc command you are looking for". The real compiler is `D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc`, resolved by `helpers/typecheck.mjs`.
2. **Tests must be run from the package directory, not the repo root.** The tests spawn children with `cwd: process.cwd()` so they resolve `tsx` through the package's `node_modules`. From the repo root `tsx` does not resolve and every child dies with `ERR_MODULE_NOT_FOUND`. **This defect was mine** — it made four `durability-advanced` tests look broken when they are **33/33** from the correct directory.

Authoritative typecheck: `node helpers/typecheck.mjs` → `typecheck: PASS -- 2 package(s), complete production graph, tests included`, with `0 non-test cast(s); baseline allows 0`. The resolved program covers 102 files (41 prod + 61 test) in `dsh-daily-work` and 49 (28 + 21) in `dsh-ipython`.

### 7.3 Test suite results, measured at the published commit

`dsh-ipython`, run from the package directory, `--no-file-parallelism`:

```
Test Files  2 failed | 19 passed (21)
     Tests  2 failed | 206 passed (208)
```

**Both failures are the same defect, and both pass in isolation.** They are:

| test | elapsed | note |
|---|---|---|
| "the record carries the kernel EPOCH, and a restart cannot deliver across generations" | 70524 ms | hit the 60 s `wait_for_ready` budget |
| "the straddling write is undecidable, and ordinary in-cell output still works" | 68138 ms | same |

Both are the intermittent `restart()` defect of §10.1c. The 68–70 s figures are **the test's own 60 s budget plus teardown**, not a measurement of work: the child never became ready. This is the single most important number in this section — **a reviewer who reads "2 failed" as two independent product failures would be wrong, and a reviewer who reads "206 passed" as "the IPython surface is fully sound" would also be wrong**, because the restart path is exactly the path a long-running session depends on.

`dsh-daily-work` was not completed for this document; its earlier full run (before the c11 cwd fix) is superseded and should not be cited. A reviewer wanting its current number should run it from `packages/dsh-daily-work`, which now passes 33/33 for the previously-failing `durability-advanced` file.

---

## 8. Publish hygiene

- **Loopback session tokens: zero remaining in the tree.** Redacted **63 occurrences across 61 files** using the project's own pattern from `run-a12.mjs:106` (`text.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')`). None of the redacted files is cited by spec evidence, so no recorded digest moved; all JSON artifacts still parse.
- **Three history-only token blobs remain reachable** from published history. Rewriting them would change every downstream commit SHA and invalidate the identity and every filed verdict, for tokens that authorize nothing on any machine a reader can reach. **Recorded as a trade not worth taking, not overlooked.**
- **No credential-shaped content in the published diff.** The one grep hit is a secret-*detection pattern* inside `.github/workflows/post-integration.yml` — the correct way to write about a credential.
- **`.github/workflows/post-integration.yml` has never executed.** No runner, no network authorization to add one. It is unvalidated YAML — a claim about what CI would do, not evidence that it does it. Its own header says so.
- `paid-live-provider.yml` triggers **only** on `workflow_dispatch` and refuses unless an authorization variable is set **and** the lock agrees; it declares no secret and echoes no key.

---

## 9. Claims a reviewer should NOT accept from this document

Stated so the audit can attack them:

1. **"104 PASS"** is a statement about the **109-case trusted-local spec**, not about the 112-case authority. **And only 3 of the 104 are at the current identity** — measured: T2 has 3 at-current and 51 not-current; T0, T1, T3 and T4 have **zero** at-current. So the honest reading is "104 verdicts, 3 of which are bound to the identity the gate currently compares against". §2.1 explains why I did not re-stamp the other 101.
2. **"76 of 112 COVERED"** means an artifact establishes each oracle. It does **not** mean the product is qualified, and much of it is measured with a controlled adapter at the provider boundary (§2.5).
3. **"The cap is binding in production"** is measured with **29 arithmetic reservations + 1 real call**, not 30 real children.
4. **"ID-01 PASS"** rests on the qualified tree being correct plus the wrong-tree diagnosis. The **main checkout still carries the defect**; `dsh-native-daily` was not fixed.
5. **"G-SEAM-19 closed in product"** covers in-process one-shot children via the `agent/created` guard. **DSH's own pool remains per-root.**
6. **The 315 verify-spec problems are unresolved.** I chose not to re-stamp. A reviewer who thinks re-stamping is correct should say so explicitly, because it changes what every one of those entries asserts.
7. **Three of the four FAILs will never pass** under the current spec text. If the audit's criterion is "zero FAILs", the correct response is to revise the spec deliberately — which invalidates every verdict at the current identity — not to re-measure.

---

## 10. What I got wrong during this round, recorded

- **I marked IPY-13 PASS, then reversed it** after writer c7's independent class probe showed the gate asserted only the weaker property. The gate was an oracle weaker than its scenario.
- **My serial suite had a cwd defect** that made four product tests look broken (§7.2). Writer c11 independently found the same root cause and fixed it properly at all five spawn sites.
- **My first IPY-15 fix wired the pump and missed the reply path.** Writer c1 found it; I closed that gap in `82ac3ee`, and c1 then went further — see §10.1.
- **I initially read the 315 verify-spec problems as a blocker.** They are reported and append no blocker by design; I verified this in source rather than inferring it from the FAIL marker.
- **A subagent reported a "collision" with a second writer in `wt-c1`.** It was me — I had finished that slice after the original agent died. I corrected it and redirected the agent to the two real gaps it had found.
- **I asserted "99 PASSes at the current identity" in a draft of §9.** Measured: **3**. Corrected before publication.

### 10.1 Two corrections that a reviewer should treat as substantive

**(a) A prior GAPS entry's central inference is invalid, and its refutation method was unsound.** Writer c11 examined `G-SEAM-39` (the `IPY-06` flake) and found:

- Its central inference reads an empty `kernel.err` as "the replacement kernel never started". **Empty `kernel.err` is the normal state on a fully successful start** (0 bytes, measured), and on failing trials the `dsh_attribution_bootstrap.loaded` marker **is present** — the replacement *did* start. The inference should be withdrawn.
- Its refutation method used a **two-trial** experiment. The baseline failure rate for this case ranges **1/8 to 5/8 on identical code**, so two trials cannot refute anything. c11 demonstrated this on itself: its first `newports` result read 5/6 vs 3/6, and an **8-trial** run reversed it (5/8 against a 7/8 baseline). Further work needs **≥20 trials per arm**.

**(b) The `dep-gates` DEP-02 failure is an environment artifact, and the correct diagnosis is NOT "deleted".** Writer c11 reported the external audit package as "deleted from `Downloads/` mid-session". **That conclusion is wrong and I corrected it by direct check: the package MOVED to `C:\Users\hzq00\Downloads\dsh\DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20\`**, and its `delivery/acceptance-spec.json` still hashes to `2fe95835425eb98eb3bac9ee…` — byte-identical to the repo copy. So the test's subject exists; the test hardcodes the old path. The failure is a **stale path in the test**, not a provenance failure, and the honest fix is to locate the package rather than to weaken the assertion. c11 was right to leave it failing rather than loosen it, and right that it is outside its eight assigned failures.

**(c) c11's IPY-06 attribution stands as a REAL product defect**, reported not fixed: `packages/dsh-ipython/src/broker.py` — `self._kc.wait_for_ready(timeout=60)` inside `restart()`. The decisive observation is that the **bare arm (start → restart, no cell, no status) fails while IPY-06's exact sequence passes 5/5**, so the injection is not the variable. Five hypotheses were tested and refuted, including `newports=True` (5/8 against a 7/8 baseline — worse). The variable that decides restart pass/fail remains **undetermined**; the highest-value next step is a broker log line naming the replacement kernel's pid and bound ports.

**Consequence for this dossier's test evidence:** the two `×` lines in the suite output at the time of writing — "the record carries the kernel EPOCH…" (70524 ms) and "the straddling write is undecidable…" (68138 ms) — are **both the same IPY-06/restart defect surfacing at the 60 s `wait_for_ready` budget**, not independent failures. Both pass in isolation. This is a real, reproducible, *intermittent* product defect, and it is the strongest open technical item in the repository.

---

## 11. Minimal next steps, ordered by value

1. **The IPY-06 / restart defect (§10.1c)** — `broker.py`'s `wait_for_ready(timeout=60)` inside `restart()`. It is **intermittent** (1/8 to 5/8 on identical code), it passes in isolation, and it is the strongest open technical item because `ipython` is the model's **only** execution surface. Add the broker log line naming the replacement kernel's pid and bound ports so the next failure is attributable from the log rather than by elimination, then run **≥20 trials per arm**.
2. **G-SEAM-44 / reachability** — 8 unreachable non-test modules in `dsh-daily-work`, of which `kernel-lifecycle.ts` makes three PASSing RECOVERY cases statements about a mechanism. Cheap to run the import-graph scan as a standing gate; no budget needed.
3. **G-SEAM-19 / host-wide capacity** — the authority's `CAP-01` requires "任何时刻不超过30". The ledger is host-wide; DSH's pool is not. This is the core capacity claim.
4. **G-SEAM-18 / depth ceiling** — `maxDepth: 99` lifts the cap and an omitted value equals 99 on the workflow/PTC path.
5. **Decide `CMP-04` and `IPY-13`** — both need a deliberate spec revision, which invalidates verdicts at the current identity. That is the delivery owner's call, not a measurement.
6. **Decide the identity regime** — adopt the V5 §14 contract identity in the gate, or record why the superseded one stays. The 315 problems clear the moment that decision is made and the evidence is re-measured under whichever regime is chosen.
7. **Fix the two stale records** — `compatibility.lock.json` → `promotion.decision_reason` names superseded identities and pairs `spec_path` with the wrong digest (§2.1); `dep-gates` DEP-02 hardcodes the audit package's old path (§10.1b).
8. **`SEC-01`/`SEC-03`** — either provision the Linux execution world or record them as non-claims, as the v1 spec already did for five authority cases it marks `NOT_APPLICABLE` while the authority provides no such status.
