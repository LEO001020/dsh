# V2 — COMPOSITION (CMP-01..CMP-14): gate table

**Family:** COMPOSITION. **Cases:** CMP-01 through CMP-14, all 14.
**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`, base HEAD `c3b9dba`.
**Deployment identity this evidence is filed under:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
(`python qualification/results/T1-spec/verify-identity.py` → *all checks passed*; run AFTER every
measurement below, see §6).

**Labels used below:** `[measured]` = a command was run and its output is quoted.
`[read in source]` = the claim comes from reading a file and is NOT evidence for a case on its own.

---

## 1. The one-line result

| | value |
|---|---|
| cases with a verdict filed | **14 of 14** |
| PASS | **12** (CMP-01, 03, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14) |
| FAIL | **2** (CMP-02, CMP-04) |
| NOT_RUN | **0** |
| BLOCKED_EXTERNAL | **0** |
| cases where the spec's oracle CONTRADICTS another case's oracle | **1** (CMP-04 vs CMP-13 — see §3) |

The two FAILs are not defects I introduced and not defects I can repair inside this family's
ownership. One is a **real open defect of the deployment** that two independent instruments
agree on (CMP-02, recorded as `G-SEAM-33` in `docs/GAPS.md`). The other is a **specification
contradiction** that was created by the composition change itself (CMP-04). Both are explained in
§3 with the evidence that establishes them.

---

## 2. What every case ran against — the build/install digests

**Nothing below was measured against a stale build or a stale install.** This is asserted rather
than promised, because both traps have already produced false findings in this project (a stale
`lib/` produced a retracted defect; two homes were found carrying an old patch).

### 2.1 The install: this family's own home, built fresh from the repository

```
D:/DSH/home/v2-cmp/profiles/daily/           <- a FRESH install, created for this family
```
`[measured]` the install command, from `docs/DELIVERY.md` §2:

```sh
cp -r profiles/daily-candidate $DSH_HOME/profiles/daily
cd $DSH_HOME/profiles/daily
DSH_HOME='D:\DSH\home\v2-cmp' node /d/DSH/src/dsh-src/apps/cli/lib/bin.js plugin --profile daily install
```

### 2.2 Installed == repo, for every input the boot reads

`[measured]` `sha256sum`, re-run **after** the last boot of this family:

| input | sha256 | installed == repo? |
|---|---|---|
| `profiles/daily-candidate/cordis.patch.yml` (repo) | `5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4` | — |
| `$DSH_HOME/profiles/daily/cordis.patch.yml` (installed) | `5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4` | **yes** |
| `presets/daily-standard/agent.cordis.yml` (repo) | `16bc20e559d0c05b810876522fd468952b421a69ed2b5276a3ddd06c01053bce` | — |
| `$DSH_HOME/profiles/daily/presets/daily-standard/agent.cordis.yml` | `16bc20e559d0c05b810876522fd468952b421a69ed2b5276a3ddd06c01053bce` | **yes** |
| `packages/dsh-daily-work/cordis.patch.yml` | `57dce19482761d827f87ae3187f96cfa0786f9a45e727c63f2454062cea1b373` | n/a (bundle layer) |
| `packages/dsh-ipython/cordis.patch.yml` | `c5c4e1c48ab10f46722228b9b8ac4e115409de2cbad63ea2861243f20a1cbbea` | n/a (bundle layer) |

The pinned values in `compatibility.lock.json` are `host_profile_digest = 5b8b2a8e…` and
`agent_preset_digest = 16bc20e5…`, and **both match what the boot actually read**. The two
installs the brief warned about (`3755f904`, `59f23346` — the stale `t4-preset` home) are NOT
what this family measured against.

### 2.3 The build: every production source has a NEWER built `lib/`

Both extension packages are installed with `link:`, so the boot resolves `lib/`, never `src/`.

`[measured]` for every `src/*.ts` that is not a test, `lib/<name>.js` exists and is newer:

| package | result |
|---|---|
| `packages/dsh-ipython` | no stale, no missing |
| `packages/dsh-daily-work` | no stale, no missing |

The `lib/` digests the boots executed, recorded in every verdict artifact:

| built file | sha256 |
|---|---|
| `packages/dsh-daily-work/lib/host.js` | `385e792444a5c34f22c6375a570c271e7973ddd3ddb89e13359dcec2205c7de9` |
| `packages/dsh-ipython/lib/ipython-tool.js` | `34807582fd6d2481d21277155fd8db870fbfc8d805ccdae9499973229b7cc14f` |

### 2.4 One host at a time, on a bound port, killed and verified released

Every boot went through `qualification/runners/boot-harness.mjs`. `[measured]` in every transcript:
`portReleased: true`, `timedOut: false`. Nine boots were run, **strictly sequentially** — no two
hosts were ever alive at once, per the CPU directive. The ports used were `10426`, `4356`, `4374`,
`4668`, `1855`→`2112`→`3202`→`4406`→`8501`, `4593`, `4618`, `9793`, `9862`, `2353`, `2482` —
all bound by the harness from port 0, never assumed.

**Every probe wrote to its own `DSH_PROBE_OUT` path and every driver called `readResult()`, which
asserts the result's `presetRoots` name the home that was booted.** `[measured]` the guard FIRED
once, correctly, when my first probe omitted the `presetRoots` field — that is recorded in §5 as
instrument-failure F-2, because it is the mechanism working.

---

## 3. The two FAILs, and why neither is repairable here

### 3.1 CMP-02 — FAIL. The sandbox mode is `workspace-write`, not `danger-full-access`.

**Oracle:** *"A row with `id: sandbox-policy` is present (NOT deleted), its configured mode is
`danger-full-access`, and its `workspaceRoot` resolves to an absolute path."*

| clause | measured | verdict |
|---|---|---|
| the row is present | `policyRowInLoader: true`, `policyRowFiberState: 2` (ACTIVE) | **holds** |
| `workspaceRoot` is absolute | `"D:\\DSH\\src\\dsh-src"` | **holds** |
| **the configured mode is `danger-full-access`** | **`"workspace-write"`** | **FAILS** |

**Two independent instruments agree**, through different access paths:

- `[measured]` `boot4-composition.json` → `sandbox.defaultMode = "workspace-write"`,
  `resolve({}).mode = "workspace-write"`, and the composed row config verbatim:
  `{"mode": {"__jsExpr": "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'"}, "workspaceRoot": {"__jsExpr": "process.cwd()"}}`
- `[measured]` `boot2-fs.json` (the shared `verify-t2-fs.mjs` probe) → `sandboxPolicyDefaultMode = "workspace-write"`, `sandboxPolicyResolved = "workspace-write"`.

**The cause, `[read in source]`:** `profiles/daily-candidate/cordis.patch.yml` has **no
`sandbox-policy` row at all**. The row comes from the upstream base bundle
(`packages/bundle/base/cordis.patch.yml:215-218`), whose expression is
`mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`. With `DSH_PERMISSION_MODE`
unset — the state of this machine — it evaluates to `workspace-write`. The project addressed the
**sibling** expression on the next line (`policy: … ? 'never' : 'ask'`, `:234`) and never
addressed `mode`.

This is **`G-SEAM-33` in `docs/GAPS.md`, an OPEN defect**, found by T5 and independently confirmed
by the root agent and by T2. This family's measurement is a third independent confirmation, not a
new finding. It is NOT repaired here: the fix is a profile edit, `eco.test.ts` pins
`DAILY_PATCH_SHA256`, and choosing between "state `danger-full-access` explicitly" and "delete the
prompt line" is an architecture decision rather than a repair an agent should make unilaterally.

**Two live consequences, both `[read in source]`, neither re-measured here:**
1. The policy injects a model-facing sentence stating a false fact about the model's own
   authority (`packages/sandbox/sandbox-policy/src/index.ts:46-47`).
2. `ptc-runtime-node` confines unless the mode is exactly `danger-full-access`
   (`packages/ptc-runtime/ptc-runtime-node/src/index.ts:224`), so **PTC is still fenced** in a
   deployment that claims no confinement. `[measured]` corroboration: `boot4-composition.json` →
   `ptcSandboxMode = "workspace-write"`.

### 3.2 CMP-04 — FAIL. The spec's oracle contradicts CMP-13's oracle, and the composition changed under the spec.

**Oracle CMP-04:** *"`toolCountAgentKey` is 28, `ipython` is present, **`pwsh` is present**, `work`
is present, `error` is null…"*

**Oracle CMP-13:** *"…`pwsh` (and any equivalent shell tool) must be **ABSENT** from the daily
catalog while `ipython` is present… A catalog that still contains `pwsh` is NOT PASS."*

**These two oracles cannot both hold for one catalog.** `[measured]` the catalog is
**27 tools with `pwsh` ABSENT** — so CMP-13 PASSES and CMP-04 FAILS, on the same measurement.

**The timeline, `[measured]` from git:**

| event | time | commit |
|---|---|---|
| the trusted-local spec was authored (CMP-04's `28`/`pwsh present` written) | `2026-09-20 04:59:30` | `f6ac93c` |
| `tool-pwsh` disabled unconditionally in the daily preset | `2026-09-20 05:18:50` | `35c829d` |

The preset change landed **19 minutes after** the spec was pinned, and the spec's
`trusted_local_acceptance_spec_sha256 = e5b6a1d2…` was frozen at the earlier state. So CMP-04's
numbers describe the composition as it was when the spec was written, and CMP-13's describe it as
it is now.

**I did not edit CMP-04's oracle.** The spec's own rules forbid it twice: *"No PASS by editing an
oracle after the fact"*, and *"A case may only be marked PASS when that file establishes THIS
oracle"*. Editing `28`→`27` and `pwsh` present→absent would be exactly the prohibited move, and it
would also silently erase the record that the spec and the deployment diverged. The honest states
are FAIL with the contradiction named, and that is what is filed.

**What a reader should conclude:** CMP-04 is not evidence that the tool surface is broken. Its
other three clauses (`ipython` present, `work` present, `error: null`) all HOLD — `[measured]`
`ipythonToolPresent: true`, `workToolPresent: true`, `error: null`. It is evidence that **the spec
as pinned no longer describes the deployment it is pinned to**, which is a fact about the delivery
rather than about the composition.

**RESOLUTION, and who owns it.** This family declined to choose unilaterally, which was correct:
repairing the contradiction means either superseding the spec under a **new identity** (which
invalidates every verdict filed under `0a0996f3…`, so it is a deliberate delivery step and not a
fix) or accepting the case as a permanent recorded contradiction. The **root agent** has since
recorded that decision path as a `note` field on the CMP-04 case itself, so the case now carries
both the FAIL and its own resolution ownership. `[measured]` the case at HEAD has keys
`[evidence, family, id, layer, mandatory, note, oracle, requirement, status, stimulus]` with
`status: "FAIL"` and the two evidence entries intact — the note was ADDED alongside the verdict,
not substituted for it.

---

## 4. The gate table — all 14 cases

Every row names the exact command, the measured result, and the evidence file. All evidence paths
are relative to the repository root.

### CMP-01 — the composed profile activates every entry — **PASS**

| | |
|---|---|
| **oracle** | zero entries report `did not activate` / `pending` / `waiting for services`; no `warning: N entries did not activate` line; the count is recorded verbatim |
| **command** | `node qualification/results/V2-composition/run-boot3-shell.mjs` (boots the profile from `D:/DSH/src/dsh-src` with `verify-t3-shell.patch.yml`) |
| **measured** | `activationCountMatch: none` (the line **does not appear**); `entryCount: 178`; `inactiveEntries: []`; `postAuditInactiveEntries: []`; `postAuditRan: true`; `activationWarningCount: 0`; `allAssertionsPass: true` |
| **also measured** | `run-boot1-surface.mjs` → `warningLines: 0`; `run-boot4-composition.mjs` → `loaderInactive: []` over 178 entries |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot3-verdict.json` |

The count is recorded verbatim as **0**. The live loader audit was taken at **two** checkpoints —
mid-`apply` and again **after** the product's own `auditStartupEntries` ran — so the zero is a
measurement of the product's own view, not a log scrape whose absence could mean "healthy" or
"never printed".

### CMP-02 — the sandbox rows exist and are explicitly `danger-full-access` — **FAIL**

| | |
|---|---|
| **oracle** | row `sandbox-policy` present; configured mode `danger-full-access`; `workspaceRoot` absolute |
| **command** | `node qualification/results/V2-composition/run-boot4-composition.mjs`; `node qualification/results/V2-composition/run-boot2-fs.mjs` |
| **measured** | row **present** and ACTIVE (`fiberState: 2`); `workspaceRoot = "D:\\DSH\\src\\dsh-src"` (**absolute**); **`defaultMode = "workspace-write"`** (both instruments) |
| **verdict** | **FAIL** — the mode clause. See §3.1. `G-SEAM-33`, OPEN. |
| **evidence** | `qualification/results/V2-composition/boot4-verdict.json`, `qualification/results/V2-composition/boot2-verdict.json` |

### CMP-03 — no silent degradation to `danger-full-access` — **PASS**

| | |
|---|---|
| **oracle** | with the provider missing the loader FAILS with an explicit error naming it and does NOT boot with an unwrapped argv or an implicit `danger-full-access`; in the normal boot the three values are separately observable and the default is EXPLICITLY CONFIGURED rather than a fallback |
| **command** | failure arm: `node qualification/results/V2-composition/run-boot5-failure-arms.mjs` (arm 2). Normal arm: `run-boot4-composition.mjs` |
| **measured — failure arm** | `toolCount: 0`; **explicit** failure: `dsh: warning: 4 entries did not activate` and `RemoteError: agent-presets: preset "daily-standard" failed to mount: 2 row(s) did not activate: workflow-ptc … waiting for ptcRuntime, sandboxPolicy`; the missing provider is **named**: `ptc-runtime … pending (waiting for services: sandbox, sandboxPolicy)`, `terminal-controller … pending (waiting for service: sandboxPolicy)`, `workspace-files … pending`, `ui-deliverables … pending` |
| **measured — normal arm** | the three values are **separately observable**: `defaultMode = "workspace-write"`, `perSession[0].override = null`, `resolve({}).mode = "workspace-write"` |
| **verdict** | **PASS** — the failure is explicit and names the provider; no silent fallback occurred (a fallback would have produced a populated tool face, and the face is `0`). The "explicitly configured" clause: see the LIMIT below. |
| **evidence** | `qualification/results/V2-composition/boot5-6-failure-arms.json`, `qualification/results/V2-composition/boot4-verdict.json` |

**LIMIT, stated rather than smoothed over.** The oracle asks that the deployment default be
*"recorded as EXPLICITLY CONFIGURED rather than a fallback"*. The product **cannot** distinguish
these two states, and says so itself: `Config`'s schema default is `'read-only'` and `defaultMode`
carries no provenance, so the guard reports `modeSource: 'unobservable'`
(`packages/dsh-daily-work/src/no-sandbox-contract.ts`, module header — `[read in source]`).
What IS measured is the composed row's config, which shows the mode arriving as an **unresolved
`!!js` expression** (`{"__jsExpr": "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'"}`) — i.e.
the deployment **never configured it at all**. That is the honest finding, and it is what CMP-02
fails on. This case's own clause (no silent degradation) holds.

### CMP-04 — the model-visible tool surface is intact and named — **FAIL**

| | |
|---|---|
| **oracle** | `toolCountAgentKey` is **28**; `ipython` present; **`pwsh` present**; `work` present; `error` null; `presetRoots` names the booted home |
| **command** | `node qualification/results/V2-composition/run-boot1-surface.mjs` (cwd `C:/`, probe adds NO row) |
| **measured** | `toolCountAgentKey = 27` (**not 28**); `ipython` **present**; `pwsh` **ABSENT**; `work` **present**; `error: null`; `presetRoots` names `D:/DSH/home/v2-cmp/profiles/daily/presets/` |
| **verdict** | **FAIL** — two clauses. See §3.2: the oracle contradicts CMP-13 and predates the preset change by 19 minutes. Not repaired. |
| **evidence** | `qualification/results/V2-composition/boot1-verdict.json` |

### CMP-05 — the preset root is anchored at the profile, not at cwd — **PASS**

| | |
|---|---|
| **oracle** | anchored: `daily-standard` resolves, the root is absolute and derived from the profile's own directory. cwd-relative: the preset is NOT found and the tool count is 0. **The failure direction is recorded.** |
| **command** | anchored: `run-boot1-surface.mjs`. Failure direction: `run-boot5-failure-arms.mjs` (arm 1) with `qualification/runners/verify-cmp-cwd-relative-root.patch.yml` |
| **measured — anchored** | `presetRoots[1].path = "D:/DSH/home/v2-cmp/profiles/daily/presets/"` — **absolute**, derived from the profile dir; `presetsListed: standard, ptc, minimal, cordis, daily-standard`; `presetDefaultId: daily-standard` |
| **measured — failure direction** | `toolCount = 0`; `RemoteError: agent-presets: preset "daily-standard" not found (available: standard, ptc, minimal, cordis)` |
| **verdict** | **PASS** — both directions measured from a FOREIGN cwd (`C:/` and `D:/DSH/src/dsh-src`, different drives from the profile) |
| **evidence** | `qualification/results/V2-composition/boot1-verdict.json`, `qualification/results/V2-composition/boot5-6-failure-arms.json` |

### CMP-06 — approval policy matches the mode and is not model-writable — **PASS**

| | |
|---|---|
| **oracle** | effective policy is `never`, declared explicitly in the profile patch rather than inherited from a workspace-write-era default; a model-originated attempt to change it has no effect and is recorded |
| **command** | `node qualification/results/V2-composition/run-boot4-composition.mjs`; corroborated by `run-boot3-shell.mjs` |
| **measured — the policy** | `configuredPolicy = "never"`; `effectivePolicyForSession = "never"`; `sessionOverride = null`; the composed row config is `{"policy": "never"}` — **explicitly declared** in the profile patch |
| **measured — model-originated attempts** | 7 attempts, **all refused**: `permission`, `permission_preset`, `approval`, `set_approval_policy`, `set_permission_mode`, `sandbox`, `escalate` → every one `isError: true`, `code: "UNKNOWN_TOOL"`. `modelCatalogHasPolicyTool: false` |
| **measured — the user-facing route is gone** | `permissionPresetsServicePresent: false`, `permissionRowDisabled: true`, `uiPermissionRowDisabled: true` |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot4-verdict.json`, `qualification/results/V2-composition/boot3-verdict.json` |

**THE DISTINCTION THIS CASE'S WORDING MAKES, AND WHY IT MATTERS.** The oracle says
**"not model-writable"**, not "immutable". Those are different claims and only the first is true.
`[measured]` the host-code route `approval.setPolicy(agent, 'ask')` **SUCCEEDS** when host code
calls it (`hostApiSetPolicyAttempt: "no throw"`, `policyAfterHostApiAttempt: "ask"`). So the
protection is **UNREACHABILITY from the model**, not immutability of the value. Both facts are
asserted separately in the evidence so a reader cannot read the PASS as the stronger claim. The
decisive read (`effectivePolicyForSession = "never"`) was taken **before** the host-code probe ran,
so the probe's own mutation cannot contaminate it.

### CMP-07 — a patch replaces the whole config object — **PASS**

| | |
|---|---|
| **oracle** | the dumped row carries every required key with its intended value, and no unmentioned key has silently reverted to a schema default |
| **command** | success direction: `run-boot4-composition.mjs`. Failure direction: `run-boot7-home-override.mjs` → `node bin.js --profile daily --dump-config --patch one-key-overlay.patch.yml` |
| **measured — success direction** | the `subagent` row's **resolved** config carries **both** keys: `maxActiveSubagents: 10` **and** `maxDepth: 1`; `configKeys: ["maxActiveSubagents","maxDepth"]`. The `agent-presets` row carries **all four**: `["default","roots","includeShippedRoot","includeUserRoot"]` with `includeShippedRoot: true` and `includeUserRoot: true` — **neither reverted** |
| **measured — failure direction** | a one-key overlay produced the dump block verbatim: `- id: subagent / name: '@deepseek-ai/dsh-subagent' / config: / maxActiveSubagents: 10` — **`maxDepth` is GONE from that row**. `subagentRowLostMaxDepth: true`, `maxDepthElsewhereInDump: 1` |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot4-verdict.json`, `qualification/results/V2-composition/boot7-home-override.json`, `qualification/results/V2-composition/boot7-dump-one-key.txt` |

The failure direction is what makes this a measurement rather than a restatement: the dialect is
**not** a deep merge, so the project's "restate every key" discipline is load-bearing, and the
success direction's `maxDepth: 1` is present **because the patch states it**, not because a merge
preserved it.

**A FALSE FAIL I CAUGHT IN MY OWN INSTRUMENT.** My first extraction tested `/maxDepth/` over the
**whole dump** and reported the sibling as *preserved*. It is not: the second occurrence is at
`daily-work-host`, a **different** row that legitimately carries its own `maxDepth: 1`. The
assertion is now **scoped to the `subagent` block**, and the other occurrence is recorded
(`maxDepthElsewhereInDump: 1`) so the scoping is auditable. Recorded because a whole-file test here
would have produced a false FAIL against a correct product.

### CMP-08 — two presets sharing one composition file stay separate — **PASS**

| | |
|---|---|
| **oracle** | each agent's catalog contains exactly its own rows, and no module-scope state crosses sessions. Shared module state is reported as the measured constraint it is. |
| **command** | literal stimulus: `node qualification/results/V2-composition/run-boot8-twin-preset.mjs`. Contrast arm: `run-boot4-composition.mjs` |
| **measured — the literal stimulus** | a second preset directory whose `agent.cordis.yml` is a **byte-identical copy** (`sameCompositionFile: true`, both `16bc20e5…`) is discovered by the roster's own directory scan. `presets = ["daily-standard:daily-standard:27", "twin:daily-standard-twin:27", "daily-standard-2:daily-standard:27"]` — the two catalogs are **identical in their own rows** and each agent mounted **its own preset id** |
| **measured — module-scope state** | two agents on the standing preset each called the **real `work` tool**: `runIdA = cmp-run-A`, `runIdB = cmp-run-B`, `resolvesItsOwnRun: true`, `noCrossResolution: true`. `agent.ctx` identity differs (`workServiceInstancesShared: false`) |
| **measured — the contrast arm** | `daily-standard` (27 tools, `ipython` + `work`) vs shipped `standard` (26 tools, `pwsh` present, **no** `ipython`, **no** `work`) — two presets in one process with different catalogs |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot8-verdict.json`, `qualification/results/V2-composition/boot4-verdict.json` |

**The measured constraint, stated rather than smoothed over.** The twin preset is a **copy**, not
an authored fixture: its digest is recorded and asserted equal to the source's, so "the same
composition file" is a measurement. And the contrast arm compares **two different files**, which is
a weaker stimulus than the oracle names — that is why the literal one was added and both are filed.

### CMP-09 — two roots on one standing scope do not contaminate each other — **PASS**

| | |
|---|---|
| **oracle** | each run's tasks, credit reservation and cancellation are fully separated; no task id, reservation or tombstone appears in the other run's record |
| **command** | `node qualification/results/V2-composition/run-boot4-composition.mjs` (interleaved: A admits → B admits → A cancels → A confirms → B admits a second) |
| **measured** | `distinctRoots: true`; A's tasks `["task-A1"]` vs B's `["task-B1","task-B2"]` — `noTaskIdCrosses: true`; A's tombstones `["task-A1"]` vs B's `[]` — `noTombstoneCrosses: true`; reservations **A = 0** (its cancelled task released) vs **B = 5** (1+2+3 reserved, none released) |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot4-verdict.json` |

The interleave is the stimulus, not decoration: any per-root state held in module scope would
surface as a crossed id at one of the five steps, and all five steps succeeded.

### CMP-10 — bundle and preset own different halves — **PASS**

| | |
|---|---|
| **oracle** | the host-scoped row is registered exactly once (no duplicate registration error, no second handle) and the agent-scoped tool row comes from the preset |
| **command** | `node qualification/results/V2-composition/run-boot4-composition.mjs` |
| **measured — host rows, exactly once** | `rowIdCounts` over 178 loader entries: `daily-work-host: 1`, `ipython-kernel-host: 1`, `sandbox-policy: 1`, `sandbox: 1`, `approval: 1`, `permission: 1`, `fs-local: 1`, `pwsh-local: 1`, `agent-presets: 1` — **zero duplicates**. No `already registered` / `provide() throws` / `second handle` line on stderr |
| **measured — the preset owns the tool rows** | `compositionInventory()` for `daily-standard` lists **31 rows**, ending `… "daily-work-tools", "ipython-tool"` with `moduleName` `dsh-daily-work/tools` and `dsh-ipython/tool`. The daily preset's row list contains **no** `daily-work-host` and **no** `ipython-kernel-host` |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot4-verdict.json` |

**A FALSE FINDING I AVOIDED, recorded because it is instructive.** My first version read the tool
rows from the **root loader** and reported them absent. They are not absent — a preset's rows are
mounted under a **standing scope**, which is a *different Loader*. The root table holds
`tool-pwsh`/`tool-fs` (host rows, disabled) and `fs-local`/`pwsh-local` (host rows, active) and
does not hold `daily-work-tools`/`ipython-tool` at all. The product's own reader for this question
is the roster's `compositionInventory()`
(`packages/preset/agent-presets/src/index.ts:325`), which is what the measurement now uses. The
first version would have filed a false defect against a correct composition.

### CMP-11 — the `ipython` tool is carried by the product — **PASS**

| | |
|---|---|
| **oracle** | the real session catalog holds `ipython`, and the probe's `presetRoots` confirms the home booted. Evidence produced by an overlay that INSERTED the row is NOT PASS. |
| **command** | `node qualification/results/V2-composition/run-boot1-surface.mjs`, after a fresh install following `docs/DELIVERY.md` §2 |
| **measured** | `ipythonToolPresent: true` in a **27-tool** catalog; `ipythonParameterNames: ["code"]`; `ipythonIsOnlyParameter: true`; `presetRoots` names `D:/DSH/home/v2-cmp/profiles/daily/presets/` — the home this family installed and booted |
| **overlay check** | `verify-deliverable-surface.patch.yml` inserts **one row, the probe itself**. It contains no `ipython-tool` row: asserted mechanically in the driver (`the overlay inserted no tool row`) |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot1-verdict.json` |

This is the case the earlier M11 evidence could NOT establish: `verify-ipython-e2e.patch.yml`
**inserted** the tool row, so it proved the tool works when a row is present without proving the
product carries one. This probe adds no row, so the catalog it reports is the profile's own.

### CMP-12 — home overrides are visible in the resolved graph — **PASS**

| | |
|---|---|
| **oracle** | the resolved graph shows the override explicitly for the canary home, and the stock control uses an **uncontaminated** home whose graph shows no such override |
| **command** | `node qualification/results/V2-composition/run-boot7-home-override.mjs` — two homes, two boots |
| **measured — CANARY** | `D:/DSH/home/v2-cmp-canary` carries `$DSH_HOME/cordis.patch.yml` setting `agent-presets.default: standard`. Boot result: **`presetDefaultId = "standard"`** (the override IS visible), 26 tools, `ipythonToolPresent: false`, `workToolPresent: false` |
| **measured — CONTROL** | `D:/DSH/home/v2-cmp-control` has **no** home patch (`control_has_home_patch: false`, asserted). Boot result: **`presetDefaultId = "daily-standard"`**, 27 tools, `ipythonToolPresent: true`, `workToolPresent: true` |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot7-home-override.json` |

A clean **one-variable experiment**: both homes were built from the same repository profile, both
were installed the same way, both were booted from the same foreign cwd with the same overlay. The
only difference is the home-level patch file. The control arm is what makes this evidence rather
than coincidence — a canary-only measurement could not tell "the home layer is read" from "that is
what the composition produces anyway".

### CMP-13 — the shell leaves the daily preset — **PASS**

| | |
|---|---|
| **oracle** | `pwsh` (and any equivalent shell tool) **ABSENT** from the daily catalog while `ipython` is present. The **full measured name set is recorded**. |
| **command** | `node qualification/results/V2-composition/run-boot1-surface.mjs`; corroborated by `run-boot3-shell.mjs` |
| **measured — the full set, verbatim (27)** | `["ask_user_question","create_goal","edit","exit_plan_mode","get_goal","glob","grep","interrupt_agent","ipython","job_kill","job_list","job_output","list_agents","present","read","read_image","send_message","skill","subagent","subagent_fork","todo_write","update_goal","web_fetch","web_search","work","workflow","write"]` |
| **measured — shell equivalence** | `pwsh`, `bash`, `shell`, `run_code` — **all absent** (asserted as a set, not just `pwsh`). `modelShellRowDisabledByPreset: true`, `pwshAbsenceIsIntentional: true`, `ipythonReplacesPwsh: true` |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/boot1-verdict.json`, `qualification/results/V2-composition/boot3-verdict.json` |

**This removes an INTERFACE, not a capability, and the record says so.** The kernel is unconfined
and has the same file/network authority the shell had (`G-SEAM-25`, `G-SEAM-30`). This PASS must
not be cited as evidence that any containment exists — the deployment claims none.

### CMP-14 — launcher args are redacted and identity-bound — **PASS**

| | |
|---|---|
| **oracle** | the recorded args are the redacted form, contain no credential material, and name the profile whose patch digest is `deployment.inputs.host_profile_digest` |
| **command** | `node qualification/results/V2-composition/run-cmp14-launcher-args.mjs` |
| **measured — the value** | `launcher_args_redacted = "--profile daily-candidate"` |
| **measured — redacted form** | carries `--profile`; carries **no** `--patch`, `--token`, `--api-key`, `--key` or `--secret` |
| **measured — no credential material** | **0** hits across 5 credential shapes. The test is shown **capable of failing**: a constructed raw control trips **3** (`sk-` key, bearer token, long base64) |
| **measured — identity-bound** | the named profile's patch is `profiles/daily-candidate/cordis.patch.yml`, sha256 `5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4` — **equal to `host_profile_digest`** |
| **verdict** | **PASS** |
| **evidence** | `qualification/results/V2-composition/cmp14-launcher-args.json` |

**TWO FINDINGS recorded on this case, neither of which is a FAIL of its oracle:**

- **`CMP-14-F1` — the recorded name is a REPOSITORY DIRECTORY name, not an install name.**
  `[measured]` three homes on this machine have `profiles/daily-candidate/` on disk and **all three**
  carry a **different** patch digest from the pin (`c9992160`, `547a59b2`, `ef189a8c` vs
  `5b8b2a8e`); every home installs the profile as `daily`, where the pin **does** match (6 of 13
  resolutions). The oracle's clause holds — the name *is* the profile whose patch hashes to the pin
  — but read as an **install name** the string selects a **stale** profile. An operator copying the
  recorded args verbatim into a boot would not necessarily get the pinned composition.
- **`CMP-14-F2` — there is no launcher-side redaction function.** `[measured]` a search **bounded**
  to `apps/cli/src/args.ts`, `bin.ts`, `profile-boot.ts` found **0** redaction-shaped lines. The
  field is **hand-authored** in `compatibility.lock.json`, so "redacted" is an authoring convention
  rather than a product mechanism that could be re-run. The clause the oracle requires (the recorded
  *value* is the redacted form) holds; what does not exist is a code path that would produce it
  again.

---

## 5. Instrument failures I hit and corrected — recorded so a reader can weigh the evidence

Four of these were **my own instrument being wrong**, and each would have produced a false finding
against a correct product. They are listed because this project's recorded failure mode is exactly
this, and because a reader who cannot see the corrections cannot judge the PASSes.

| # | what happened | how it read | what it actually was |
|---|---|---|---|
| F-1 | the `ipython` probe's result was read from a **fixed path** and did not name the booted home | "another agent's result" | the harness's `readResult()` guard **worked**. Fixed by giving the probe a `DSH_PROBE_OUT` path and asserting `presetRoots` |
| F-2 | my first composition probe omitted `presetRoots` entirely, so ownership could not be checked | `checks=0/1` | the guard refusing to certify an unattributable result. Fixed by reporting `presetRoots` first and unconditionally |
| F-3 | I read `entry.options.id` / `.name` for the mounted preset rows | "every preset carries **zero** rows" — a false finding | the fields are **`entryId` / `moduleName`** (`composition-inventory.ts:36-50`). Fixed |
| F-4 | I read the tool rows from the **root loader** | "the preset does not carry `daily-work-tools`/`ipython-tool`" | a preset's rows live under a **standing scope**, a different Loader. Fixed by using the roster's own `compositionInventory()` |
| F-5 | a whole-file `/maxDepth/` test for CMP-07's failure direction | "the sibling key **survived** the one-key patch" | the second occurrence is a **different row** (`daily-work-host`). Fixed by scoping the assertion to the `subagent` block |
| F-6 | a 3-parameter `check()` called with 4 arguments | every check compared its own **label string** to `true`, so all six read as FAIL | the instrument, not the product. Fixed the signature; the six then read PASS |
| F-7 | a syntax error in the probe (`roster` declared twice) | the host printed `1 entry did not activate … failed to import` — which **looks exactly like a composition failure** | my own syntax error. Caught by importing the probe standalone before booting again |

**The pattern, stated once:** in every one of F-3 through F-7 the instrument's failure was
**indistinguishable from a product failure** until it was traced. That is why every check in this
family records the **observed value** alongside the verdict rather than a bare boolean.

---

## 6. Identity and freshness — asserted at the end, not the start

`[measured]` after every measurement above:

```
python qualification/results/T1-spec/verify-identity.py   ->  all checks passed.
```

`[measured]` the identity the evidence is filed under:

```
compatibility.lock.json -> deployment.identity
  0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461
```

`[measured]` `trusted_local_acceptance_spec_sha256 = e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7`,
which is the digest of the **frozen as-authored** artifact
`qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json`. **This family did
not re-pin the lock and did not edit the pinned digest** — moving the identity would invalidate
every verdict already filed under it.

`[measured]` the four inputs re-hashed **after** the last boot: the installed profile patch and the
installed preset are **byte-identical** to their repository sources (§2.2). No sibling agent
rebuilt `lib/` under this family mid-measurement; the `lib/` digests are identical in every verdict
artifact across all nine boots.

---

## 7. Label-vs-spec mapping (the coordinator's warning, applied)

This family's evidence contains labels that **also appear as spec case ids** elsewhere in the spec.
Mapping was done **by oracle, never by label**. The table exists so a reader does not inherit an
assumption.

| label seen in a file | what it actually measures | spec case it was filed against | why |
|---|---|---|---|
| `verify-t3-shell.mjs`'s `CMP-…` — none | — | — | the t3-shell probe carries **no** `CMP-*` label at all; it was used as an **instrument** for CMP-01 and CMP-06 by reading its measured fields |
| `verify-t2-fs.mjs`'s `T2` | the fs-provider swap and the sandbox policy mode | **CMP-02** | by ORACLE: its `sandboxPolicyDefaultMode` / `sandboxPolicyResolved` fields establish CMP-02's mode clause. Its `T2` label is a **tier** label, not a case id |
| `verify-t4-preset.mjs`'s `T4-preset` | the preset plane's catalog | **CMP-13** (corroboration) | by ORACLE: its `pwshToolPresent` / `ipythonToolPresent` establish CMP-13's set. `T4` is a tier label |
| the spec's **CMP-13** | the shell LEFT the daily preset | **CMP-13** | label and case agree, and the oracle was read to confirm it |
| the spec's **CMP-04** | the tool surface is **intact** with 28 tools and `pwsh` present | **CMP-04** | filed as **FAIL** precisely because the oracle was read and did **not** match CMP-13's |
| `verify-deliverable-surface.mjs`'s `M12` | the deliverable's own tool catalog | **CMP-11** | by ORACLE: "the product carries the tool", which is what this probe adds no row to measure |
| `run-boot8`'s `daily-standard-twin` | two presets from ONE composition file | **CMP-08** | by ORACLE: the oracle's stimulus is "the SAME composition file", which is what the byte-identical twin establishes |

**No case in this family was filed against a label.** Every case was filed by reading its `oracle`
field and locating the measurement that establishes **that** — which is how CMP-04's contradiction
with CMP-13 was found at all.

---

## 8. Reproduce

```sh
cd /d/DSH/work/dsh-native-daily

# 0. fresh install into this family's own home (never a shared one)
mkdir -p /d/DSH/home/v2-cmp/profiles
cp -r profiles/daily-candidate /d/DSH/home/v2-cmp/profiles/daily
cd /d/DSH/home/v2-cmp/profiles/daily
DSH_HOME='D:\DSH\home\v2-cmp' node /d/DSH/src/dsh-src/apps/cli/lib/bin.js plugin --profile daily install
cd /d/DSH/work/dsh-native-daily

# 1. CMP-04 / 05(anchored) / 11 / 13 / 01    expect 27 tools, pwsh absent, 15/17 (2 FAIL = CMP-04's oracle)
node qualification/results/V2-composition/run-boot1-surface.mjs

# 2. CMP-02 (independent instrument)           expect defaultMode=workspace-write, 6/8
node qualification/results/V2-composition/run-boot2-fs.mjs

# 3. CMP-01 / 06 / 13 (corroboration)          expect 16/16, 0 activation warnings
node qualification/results/V2-composition/run-boot3-shell.mjs

# 4. CMP-02/03/06/07/08/09/10                  expect 45/46 (1 FAIL = CMP-02's mode)
node qualification/results/V2-composition/run-boot4-composition.mjs

# 5. CMP-05(failure) / CMP-03(failure)         expect toolCount 0 with an explicit named error, both arms
node qualification/results/V2-composition/run-boot5-failure-arms.mjs

# 6. CMP-12 canary+control / CMP-07 failure     expect canary default=standard(26), control default=daily-standard(27)
node qualification/results/V2-composition/run-boot7-home-override.mjs

# 7. CMP-08 literal stimulus                    expect 10/10, two presets from one byte-identical file
node qualification/results/V2-composition/run-boot8-twin-preset.mjs

# 8. CMP-14                                     expect 6/6
node qualification/results/V2-composition/run-cmp14-launcher-args.mjs

# 9. identity, LAST
python qualification/results/T1-spec/verify-identity.py     # expect: all checks passed
python qualification/runners/verify-spec.py                 # the mechanical gate
```

---

## 9. What this family does NOT establish

Stated so a green row is not over-read.

1. **No containment of any kind.** The deployment claims none, and nothing here measures any. CMP-13's
   shell removal is an interface change, not a boundary (`G-SEAM-25`, `G-SEAM-30`).
2. **No live-provider behaviour.** Every boot used the composed profile with no live model. Nothing
   here is evidence at layer T5.
3. **CMP-02's PASS-clauses are not a PASS of the case.** The row's presence and the absolute
   `workspaceRoot` hold; the case fails on the mode. A reader must not cite this family for
   "the sandbox rows are configured as danger-full-access".
4. **CMP-04 is a FAIL, not a defect report about the tool surface.** Its other three clauses hold.
   It is evidence that the pinned spec no longer describes the deployment.
5. **CMP-06's protection is unreachability, not immutability** — measured and stated in §4.
6. **The twin-preset stimulus is a copy, not an authored fixture**, and its digest equality is
   asserted rather than assumed.
