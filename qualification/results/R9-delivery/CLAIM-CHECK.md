# R9 — delivery claim-check, corrections, and the promotion verdict

**Role.** R9 of the delivery pass. This is the artifact to read to decide whether to
promote the system to daily use. It checks the delivery docs against the tree as it
actually is, records every correction, and states the verdict with its full basis.

**Tree this was checked against.** Repo `D:\DSH\work\dsh-native-daily`, branch
`ipython-native`, HEAD **`0751e9d`** when the checks below were run (the tree was
moving during the pass; where a claim depends on a commit it is named inline).
Pinned DSH `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`,
unmodified. Node v24.18.0.

**Method.** Every checkable claim — command, path, hash, count, version, and every
`VERIFIED` marker — was extracted from `README.md`, `docs/DELIVERY.md`,
`docs/OPERATIONS.md`, `docs/RECOVERY.md` and `docs/DELETE-AUDIT.md` and checked
against the tree, the pinned checkout, or a run on this machine. The docs' own
convention is kept: **`VERIFIED` means the command was run on this machine, and
nothing below is marked VERIFIED that was not personally run in this pass.**

### Evidence files in this directory, and an uncommitted rename

| File | What it is |
|---|---|
| `surface-r9-verified-fresh-install.json` | **The primary evidence.** Fresh install following `DELIVERY.md` §2, booted from a foreign cwd, probe adding no row, `presetRoots` confirming the booted home. 28 tools, both tools present, `error: null` |
| `surface-r9-broken-pathname-form.json` | The **failure** direction: the same manual against the pre-fix `pathname` root. 0 tools, `preset "daily-standard" not found` |
| `surface-r9-user-root-workaround.json` | The intermediate run that isolated the cause: a `.agent-presets` copy made the preset resolve, proving the root (not the row) was broken |
| `r9-surface-probe.mjs`, `r9-surface.patch.yml` | The R9-owned copy of the probe and its overlay, so this pass did not contend for the shared `M12` output path |

**Uncommitted rename, so a reader is not confused by `git status`:** two earlier
files in this directory (`surface-r9-fresh-install.json`,
`surface-r9-user-root-present.json`) were **committed by another agent** in
`084bb23` before their names were corrected. In the working tree they are renamed
to `surface-r9-broken-pathname-form.json` and `surface-r9-user-root-workaround.json`,
so `git status` shows the old names as deleted and the new ones as untracked. **The
contents are the same runs; only the names changed**, and the new names say what
each file actually is — the old ones implied the fresh install had succeeded when
that particular run was the *broken* one. This pass does not commit.

---

## 1. The promotion verdict

### `NOT_READY`

`qualification/gates-summary.json` and `compatibility.lock.json` both record
`NOT_READY`. **This pass did not change it, and did not look for a way to.** The
counts below were re-read from `qualification/gates.json` on disk rather than copied
from an earlier revision.

### 1.1 The counts, with their basis

`qualification/gates.json` is a bare array of **104** old-spec gate objects. Its
`required_for` field splits them three ways:

| | Total | PASS | NOT_RUN | FAIL | BLOCKED_EXTERNAL | NOT_APPLICABLE |
|---|---|---|---|---|---|---|
| **all gates** | **104** | 85 | 10 | 2 | 1 | 6 |
| `required_for: daily_ready` (mandatory) | **88** | **75** | **10** | **2** | **1** | 0 |
| `required_for: offline_qualified` | 10 | 10 | 0 | 0 | 0 | 0 |
| `required_for: conditional` | 6 | 0 | 0 | 0 | 0 | 6 |

`qualification/gates-summary.json` agrees exactly: `total 104`, `PASS 85`, `FAIL 2`,
`RUNNING 0`, `BLOCKED_EXTERNAL 1`, `NOT_RUN 10`, `NOT_APPLICABLE 6`,
`promotion_decision: NOT_READY`.

**Re-verified rather than inherited:** `python qualification/runners/build-gates.py`
was run in this pass and regenerated `qualification/gates.json` +
`qualification/gates-summary.json` byte-identically (no diff against HEAD). The
generator reads the deployment identity out of the lock, so the two files cannot
disagree with it.

### 1.2 Every non-PASS mandatory gate, named with its one-line reason

Thirteen gates. This is the complete basis of the verdict.

| Gate | Status | Reason |
|---|---|---|
| `A12` | `NOT_RUN` | The real daily host was never qualified end to end. PARTIAL: it booted to the CREDENTIAL boundary — real port bound, fence 401, token URL → cookie → 200 app shell, `session/create` + `session/list` round-tripped, both C2 changes in the booted graph — then stopped at `MISSING_CREDENTIAL`. **No model turn ran.** |
| `C01` | `BLOCKED_EXTERNAL` | T1 measured: 20 tasks submitted against N=10, ten admitted and ten refused, ten distinct children each reaching a real model request in their own durable Session, each `delegationDepthOf() === 1`. T5, the **live paid** run, is blocked. |
| `E01` | `FAIL` | A confined child **read** a canary secret outside the workspace root verbatim, exit 0, under **both** `read-only` and `workspace-write`. The boundary is writes only; the seam has no read lever in principle. |
| `E02` | `NOT_RUN` | PARTIAL: the surface shape is proven (the preset mounts no terminal tool and this project adds none). No live model-to-control-plane probe has been run. |
| `E06` | `FAIL` | A confined child completed a real HTTP round trip to a loopback server and connected to a public address, under both modes. No egress vocabulary exists in any sandbox backend. |
| `E12` | `NOT_RUN` | Verification-code isolation has not been exercised; the verifier is not built. |
| `R01` | `NOT_RUN` | PARTIAL: the four links are proven against different substrates and each test says which; the full real search chain is not. |
| `U01` | `NOT_RUN` | No real coding task has been run under a frozen configuration. |
| `U02` | `NOT_RUN` | No real research task has been run. |
| `U03` | `NOT_RUN` | No sustained daily load has been run. |
| `U04` | `NOT_RUN` | No paired C0/C1/C2 comparison has been run. |
| `U05` | `NOT_RUN` | No canary upgrade has been run. |
| `U06` | `NOT_RUN` | No rollback has been exercised. The temp-home rehearsal (§4 below) is a rehearsal, not this gate. |

The 6 `NOT_APPLICABLE` gates are `W01`–`W03` and `J01`–`J03`, all
`required_for: conditional`, so none of them bears on the verdict. Note that
`J01`–`J03` are `NOT_APPLICABLE` on the note "No dedicated kernel is implemented;
the native terminal was qualified instead" — **the new architecture makes that
kernel mandatory, so those three are live obligations under the new spec** even
though they do not count against the old one.

### 1.3 The external blocker, named exactly

`compatibility.lock.json` → `runtime_authorization.live_provider_budget_authorized`
is **`false`**.

The same object records `budget_amount: null`, `currency: null`, `deadline: null`,
`restart_resume_authorized: false`, `external_publication_authorized: false`. It
holds `C01` at `BLOCKED_EXTERNAL`, and it blocks the paid halves of the new spec's
`ECO-07`, `ECO-08` and `UPG-07`.

**A credential being present would not change this.** The field is an explicit
authorization, not a credential check — no key was read, printed or used in this
pass, and nothing in this document should be read as implying one exists.

### 1.4 What a reader would have to authorize or fix

Nothing below is a request, and none of it is done.

1. **Authorize a live provider budget** — set
   `live_provider_budget_authorized: true` and record an amount. This is the only
   item that is purely an authorization, and it is the single change that unblocks
   `C01`.
2. **Fix the two `FAIL`s, which are platform facts rather than unbuilt work.**
   `E01` and `E06` **cannot be closed on this host**: `SandboxPolicy` carries only
   `mode` + `workspaceRoot`, the Windows ACL backend's own header says reads and
   network are not restricted, and `ConfinedArgv` has no field in which a read or
   network denial could even be reported. Closing them means moving the production
   path to the documented Linux/SSH execution world, not editing this repo. A
   reader who wants a *green* E01/E06 should understand they are asking for a
   different substrate.
3. **Build and measure the ten `NOT_RUN` gates**: the real daily host (`A12`), the
   control-plane probe (`E02`), verification isolation (`E12`), the real search
   chain (`R01`), and the six `U` gates (a real coding task, a real research task,
   sustained load, a paired comparison, a canary upgrade, and an exercised
   rollback).
4. **Build the new architecture**, which is a separate and larger obligation. The
   112-case spec in `qualification/specs/acceptance-spec.json` is **112/112
   `NOT_RUN`** (verified by reading every entry, not by sampling) and shares
   **zero** case ids with the 104-case report — verified by set intersection, which
   is empty. **No gate in this report is progress toward it.**

---

## 2. Claim check: every claim checked, and its verdict

`VERIFIED` = run on this machine during this pass. `OK` = checked against the tree
or pinned source by reading/hashing. `STALE`/`WRONG` = corrected, with the
correction in §3.

### 2.1 `README.md`

| # | Claim | Verdict | Evidence used |
|---|---|---|---|
| R-1 | `packages/dsh-ipython` is "untracked work with no `package.json`, no `lib/`, no bundle patch and no test — it cannot be loaded by any profile" | **WRONG** | Package has `package.json` (with `dsh.bundle.patch`), `cordis.patch.yml`, compiled `lib/` (10 files), `src/*.test.ts`, and a passing suite |
| R-2 | "all 112 new cases are `NOT_RUN`" | **OK (correct, and re-verified)** | Every one of the 112 entries in `acceptance-spec.json` carries `"status": "NOT_RUN"` |
| R-3 | "the measured catalog is 27 tools including `pwsh` and no `python_exec`" (stated twice) | **STALE** | 28 measured three ways; the 27 predates the `ipython` row |
| R-4 | "Test count: 592 collected across 37 files … at `2d4534f`" | **STALE** | `vitest list` at `a1d6e6d` = **1084 across 47 files** (VERIFIED) |
| R-5 | `packages/dsh-daily-work` "exports five mount points" | **STALE** | `package.json` declares **11** exports |
| R-6 | "The product path is ten modules … `launch-port` … reachable only from tests" | **STALE** | Current graph: 25 reachable / 6 unreachable; `launch-port.ts` is on the product path; `verify.ts` reachable via `writers` |
| R-7 | `docs/INVARIANTS.md` has "40 invariants" | **WRONG** | 48 `INV-` rows |
| R-8 | "124 match, 3 do not" for the 127 evidence hashes | **WRONG** | Re-hashed: **127 match, 0 missing, 0 stale** |
| R-9 | "85 of 104 gates PASS, 2 are honest FAILs" | **OK** | Confirmed against `gates.json` |
| R-10 | "75 PASS, 10 `NOT_RUN`, 2 `FAIL`, 1 `BLOCKED_EXTERNAL`" of 88 mandatory | **OK** | Confirmed by recomputing from `required_for` |
| R-11 | Commit messages for `2d4534f`, `b8f1ef2`, `982e82b` | **OK** | `git log -1` matches each quoted subject verbatim |
| R-12 | `qualification/gates.json` is "All 104 gates … (schema_version 1 — the OLD spec)" | **OK** | 104 objects; the spec file is `schema_version: 1` |
| R-13 | "Ten children … through the real `ctx.subagents.startContinuable` seam" | **OK — not re-run** | Cites `M3.2-N10-concurrency/`; the evidence is on disk and the gate row says so. **This pass did not re-execute it** (a live N=10 run is out of scope and would contend with other agents) |
| R-14 | "A run survives a real SIGKILL … 4 consecutive runs, all six checks true" | **OK — not re-run** | `M4.1-process-kill/report-final.json`: `childExitSignal: SIGKILL`, `terminatedAbruptly: true`, and a `checks` object with all six `true` |
| R-15 | "`production-port.test.ts` (`b8f1ef2`) installs nothing" | **OK — read, not run** | The test file exists; `createRun` calls `installDefaultLaunchPort(root)` at `host.ts:518` |
| R-16 | "the Goal handover … `982e82b` … nothing *reads* `.continuation` yet" | **OK** | `grep '\.continuation'` over non-test `src/` returns only the write in `record.ts:501` |

### 2.2 `docs/DELIVERY.md`

| # | Claim | Verdict | Evidence used |
|---|---|---|---|
| D-1 | Deployment identity `73da4c62…` | **STALE** | Current identity is `ece4037a…` (recomputed from `deployment.inputs`; matches lock, summary and all 85 PASS rows) |
| D-2 | "The identity was re-derived **once**" | **STALE** | Re-derived three times: `0ca14d4e…` → `73da4c62…` → `6b214b9f…` → `ece4037a…` |
| D-3 | "no `ipykernel`, `jupyter_client` or `python_exec`" in the product (§5) | **STALE** | True of `dsh-daily-work`; the kernel lives in `dsh-ipython`, which the profile loads |
| D-4 | Known limit 1: "No reachable IPython … no `package.json`, no `lib/`, no `cordis.patch.yml` and no test" | **WRONG** | See R-1; corrected in place |
| D-5 | "Test count: 592 collected across 37 files … at `2d4534f`" | **STALE** | 1084 / 47 at `a1d6e6d` (VERIFIED) |
| D-6 | "3 of 127 references no longer match the file on disk" | **WRONG** | 127/127 match |
| D-7 | Launcher sha256 `69c49c87…` | **OK** | `sha256sum apps/cli/lib/bin.js` in the pinned checkout |
| D-8 | Pinned commit / tag / version / `packageManager` / engines | **OK** | `git rev-parse HEAD`, `git describe --tags`, `package.json` — all four agree |
| D-9 | `D:\DSH\tools\bin\pnpm` is pnpm 11.7.0 | **VERIFIED** | `pnpm --version` → `11.7.0` via the shim |
| D-10 | "Daily home: **not created**" | **OK** | `D:\DSH\home\daily` does not exist |
| D-11 | §2 install commands | **VERIFIED (procedure re-run in part)** | The profile-install step was run end to end on three fresh homes; the `corepack pnpm install` and `pnpm build` steps were not re-run (a rebuild would invalidate the artifact hash every other agent is citing) |
| D-12 | `--dump-config` / `--dump-default-config` exist and differ as described | **VERIFIED** | Both flags in `--help`; `--dump-config` output includes the profile layer and the two bundle layers |
| D-13 | Trap 6b: `URL.pathname` on Windows yields `/D:/…` and `resolve()` makes it meaningless | **VERIFIED, both directions** | `new URL('presets/','file:///D:/x/').pathname` → `"/D:/x/presets/"`; `path.resolve` of that from a different drive → `C:\D:\x\presets`, `existsSync` false. End-to-end: broken form → 0 tools; fixed form → 28 tools |
| D-14 | Spill citations (`maxInlineBytes: 50000` at `base/cordis.patch.yml:393-396`; `mkdtempSync` at `store.ts:36-38`; hint at `index.ts:156,159`) | **OK, with one line-number nit** | `maxInlineBytes: 50000` is at `:396`; `spill-local` mount at `:390-391`. `mkdtempSync` at `store.ts:37` (function at 36). Hint verbatim at `index.ts:159`; the locator is at `:157`, not `:156` |
| D-15 | "`tool-plugin-manager` is disabled … (`E04` PASS)" | **OK** | `disabled: true` at line 266 of the shipped `standard` preset |
| D-16 | Terminal framing 138–185 ms vs 3025–3135 ms | **OK** | `M9.2-terminal-advanced/FINDINGS.md:270-271` |
| D-17 | "10.0.26200" OS, "AMD64" | **OK** | Lock `os_and_architecture`, and this machine |
| D-18 | §12 rollback "VERIFIED as a rehearsal" | **OK as a rehearsal — NOT as an exercised procedure** | `u06-rollback-rerun.json`: 12/12 PASS, with `notClaimed` naming both substitutions. The shell sequence in §12 has **never** been run end to end |
| D-19 | The rehearsal "says so in its own `notExercised` field" | **WRONG (field name)** | The JSON's field is **`notClaimed`**; `notExercised` exists only in the `.mjs` source at line 434. Both files were corrected |
| D-20 | §9 promotion counts | **OK** | Recomputed; identical |

### 2.3 `docs/OPERATIONS.md`

| # | Claim | Verdict | Evidence used |
|---|---|---|---|
| O-1 | Pinned identity block (commit, tag, version, pnpm, node, artifact sha256) | **OK** | All five re-checked; identical to DELIVERY §1 |
| O-2 | "Test count: 592 collected across 37 files" | **STALE** | 1084 / 47 (VERIFIED) |
| O-3 | "`D:\DSH\home\canary`, `canary3`" as the canary homes | **INCOMPLETE** | Nine canary homes exist (`canary`…`canary8`, plus `m914`) |
| O-4 | "Restore the old artifact and the old state snapshot … " with no sequence | **STALE (thin)** | Replaced with a pointer to DELIVERY §12 plus an explicit rehearsal-not-exercised marker |
| O-5 | `link-all-dsh.ps1` exists and is the one to use | **OK** | Both `link-all-dsh.ps1` and `link-dsh.cmd` present |
| O-6 | `--dump-default-config` "deliberately omits the profile's own patch layer" | **OK** | Matches the CLI help text verbatim |

### 2.4 `docs/RECOVERY.md`

| # | Claim | Verdict | Evidence used |
|---|---|---|---|
| C-1 | "An old epoch is never reused. Stale callbacks are rejected when writing authoritative records." | **WRONG** | The guard exists in `recovery.ts` but is **unreachable from any production path**; `epoch` is inert. `record.ts:410-437` documents exactly this |
| C-2 | "an explicit persisted per-run … authorization **with a TTL**" | **WRONG** | The field is `restartResumeAuthorized: z.boolean()`; **there is no TTL anywhere in the implementation** |
| C-3 | The five positions / admission states / shutdown order | **OK** | `states.ts` `ADMISSION_STATES`; shutdown order matches `M8.2-lifecycle-gates` and the suite's teardown |
| C-4 | "The N=10 concurrency suite hung for 60 seconds per test until this order was found" | **OK — not re-run** | Consistent with `vitest.config.ts`'s explicit 60 s hook budget and its comment |
| C-5 | Rollback paragraph | **STALE (thin)** | Replaced with the concrete sequence pointer and an honesty marker |

### 2.5 `docs/DELETE-AUDIT.md`

| # | Claim | Verdict | Evidence used |
|---|---|---|---|
| A-1 | "`packages/dsh-ipython/` … has no `package.json`, no `lib/`, no `cordis.patch.yml`, no test file, and no export" | **WRONG** | See R-1 |
| A-2 | "27 tools including `pwsh`" (§3.4 and §3.6) | **STALE** | 28 |
| A-3 | §3.7 lists `probe-m7.test.ts`, `spike.test.ts`, `sig-probe.mjs` as present | **STALE for the first two** | Both test files are gone from the tree; `sig-probe.mjs` is still ` D` |
| A-4 | "`gates.json` has not been regenerated against them" (the new suites) | **OK** | Regenerating produced no diff, so the report is current |
| A-5 | "124 match, 3 do not" | **WRONG** | 127/127 |
| A-6 | §1 import graph: 5 exports, 11 reachable modules, `verify.ts` unreachable | **STALE** | 11 exports, 25 reachable / 6 unreachable, `verify.ts` reachable via `writers` |
| A-7 | The preset in use is `D:\DSH\home\canary5\.agent-presets\…` | **STALE** | Now shipped in-repo at `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` |
| A-8 | "This project adds **no** execution tool" | **OK for `dsh-daily-work`, incomplete for the tree** | `dsh-ipython` adds the `ipython` tool; noted in place |
| A-9 | §5b does not exist — no delete/replace inventory | **MISSING** | Added; see §4 |
| A-10 | `effects.ts` 1373 lines; `host.ts` ~1150 | **OK, one number moved** | `effects.ts` still 1373; `host.ts` is now **1399** |
| A-11 | "35 added lines, 0 removed" between shipped `standard` and the repo preset | **VERIFIED** | `diff` in the pinned checkout: 35 `>` lines, 0 `<` lines |
| A-12 | The patch dialect has no delete verb | **OK** | `vendor/include/src/index.ts:77-100` — `{ id, insert, name, ...overrides }`; `insert` pushes |

### 2.6 Evidence files the docs cite

| Cited path | Verdict |
|---|---|
| `M0.6-launcher-identity/` | exists |
| `M4.1-process-kill/report-final.json` | exists; six checks true, `SIGKILL` |
| `M9.20-real-tasks/u06-rollback.mjs` + `.json` | exist; R8a PASS; `notClaimed` present |
| `M5-lifecycle/PROBE-FACTS.md` facts 8–10, 16 | exist; facts match the quoted numbers |
| `M11-ipython/cases.json`, `e2e-tool.json`, `TRANSPORT-FINDINGS.md` | exist |
| `M12-deliverable-surface/surface.json` | exists — **and was contaminated; see §5** |
| `M8.5-c2-real-boot/e2e-tool.json` | exists; real but stale (27, pre-`ipython`) |
| `M9.2-terminal-advanced/FINDINGS.md` | exists; hashes to `615adaad…` as the gate rows say |
| `qualification/specs/acceptance-spec.json` | exists; sha256 `2fe95835…` matches the lock input |
| `python <delivery-package>/helpers/doctor.py` | **resolves** to `D:\DSH\upload-dsh\00-plan\helpers\doctor.py`; run in this pass, exit 0 |

---

## 3. Every correction made, before → after

All corrections are in files this pass owns. Line numbers are from the pre-edit
file where a "before" line is quoted.

| File | Before | After |
|---|---|---|
| `README.md:86` | "**Test count: 592 collected across 37 files.** Measured … at commit `2d4534f`" | 1084 across 47 files at `a1d6e6d`, with the earlier figure named as accurate-for-its-tree and superseded |
| `README.md:113-115` | "the `work` tool reaches the model: a real Session … reports 27 tools including `work`" | both tools reach the model; **28** tools including `work` and `ipython` |
| `README.md:142-156` | "The new architecture is **not implemented**. There is no reachable IPython kernel … A `packages/dsh-ipython/` package has started as untracked work (`protocol.ts`, `broker.py`) but has **no `package.json`, no `lib/`, no bundle patch and no test** — it cannot be loaded by any profile." | rewritten: the package is a real bundle and reaches the model; what is missing is `python_exec`, the shell leaving the preset, the UI N control and the hard host-wide 30. The withdrawn sentence is quoted so a reader can see what changed |
| `README.md:155-156` | "The model's execution surface is still `pwsh`. … 27 tools including `pwsh` and **no** `python_exec`." | "`pwsh` AND `ipython`, not `python_exec`"; 28; the reason it is still unproven is that the shell has not left the preset |
| `README.md:268-274` | "124 match, 3 do not — T05, T06 and T08 … `1f1408e7…` … `615adaad…`" | retracted: 127 match, 0 stale; the retraction is recorded, not silently dropped |
| `README.md:44` | `qualification/gates.json` row — no old/new spec note | marked as the OLD spec |
| `README.md:47` | "`packages/dsh-daily-work/` — The one extension package" | two packages, with export counts |
| `README.md:37` | "40 invariants" | 48 |
| `README.md:51-67` | "exports five mount points"; "The product path is ten modules … `launch-port` … reachable only from tests" | eleven exports; current graph 25/6; `launch-port.ts` on the product path, `verify.ts` reachable via `writers` |
| `README.md:7-16` | "**None of that is built here.**" | "**Part of that is now built and part is not — do not read this banner as 'none of it'**", with the split named |
| `README.md:280-289` | promotion paragraph with the two old numbers | verdict restated with the 13 non-PASS gates named, the blocker quoted exactly, and the "112/112 `NOT_RUN`" re-verified rather than inherited |
| `docs/DELIVERY.md:32-48` | identity `73da4c62…`; "re-derived **once**" | identity `ece4037a…`; three re-derivations with the cause of each; the recompute command given so a reader can check it |
| `docs/DELIVERY.md:111` | "Test count: 592 collected across 37 files … `2d4534f`" | 1084 / 47 at `a1d6e6d` |
| `docs/DELIVERY.md:208-212` | "The figure cannot be re-verified at an arbitrary later commit" | replaced with the measured figure and a note on what a collection count can and cannot support |
| `docs/DELIVERY.md:351-355` | "**There is no IPython kernel in this product yet.** `grep` … finds no `ipykernel`…" | the grep was correct about `dsh-daily-work` and is now misleading about the product; the kernel is in `dsh-ipython`. The **subject** of §5 (a recovery path that is `NOT_RUN`) is unchanged |
| `docs/DELIVERY.md:539-543` | Known limit 1: "No reachable IPython … 27 tools … no `package.json`, no `lib/`, no `cordis.patch.yml` and no test" | rewritten: the package exists, is loadable, and reaches the model; the unbuilt remainder named |
| `docs/DELIVERY.md` §8.2 | *did not exist* | **added**: the 27-vs-28 table with four evidence rows, the contaminated-M12 caveat, and the "28 is not a new-spec PASS" caveat |
| `docs/DELIVERY.md:603-657` | promotion counts + "3 of 127 … stale" + a three-bullet list | full basis: the three-way `required_for` split, a **table of all 13 non-PASS mandatory gates** with reasons, the blocker quoted as a JSON path and value, and a four-item "what a reader would have to authorize or fix" |
| `docs/DELIVERY.md:719-726` | rollback: three numbered lines and a "VERIFIED as a rehearsal" paragraph ending "`notExercised` field" | concrete 7-step sequence with the stop-first precondition, tree-digest verification, reconcile-before-rewind ordering, three encoded rules, a **rehearsed-not-exercised** marker, and the corrected field name `notClaimed`. The shell sequence is explicitly marked NOT VERIFIED |
| `docs/DELIVERY.md:208` (verify-install) | `--no-open`; read `M12-deliverable-surface/surface.json` | `--port 0` (with the `EADDRINUSE` failure named), the R9 probe path, and **two traps** about the fixed output path and the roots-assertion check |
| `docs/DELIVERY.md:816` | "There is no kernel yet, and when there is, its memory will not be in the backup" | a kernel now exists and its memory is still not in the backup |
| `docs/OPERATIONS.md:125` | "592 collected across 37 files" | 1084 / 47, with both earlier figures named |
| `docs/OPERATIONS.md:14` | "`canary`, `canary3`" | `canary`…`canary8` plus `m914` |
| `docs/OPERATIONS.md:180-185` | rollback in one thin paragraph | pointer to DELIVERY §12 plus the rehearsed-not-exercised marker |
| `docs/RECOVERY.md:34-35` | "An old epoch is never reused. Stale callbacks are rejected when writing authoritative records." | rewritten to say what is actually enforced (object identity, in-process) versus what is inert (the epoch field), and that `record.ts:410-437` says so |
| `docs/RECOVERY.md:74` | "authorization **with a TTL**" | `restartResumeAuthorized`, a boolean defaulting to false; **no TTL exists** |
| `docs/RECOVERY.md` (rollback) | thin paragraph | concrete sequence pointer + honesty marker |
| `docs/DELETE-AUDIT.md:25-33` | header snapshot note with no correction | correction note: the snapshot moved; §3.6/§3.7/§5/§5b say what is true now |
| `docs/DELETE-AUDIT.md:457-459` | "This project adds **no** execution tool" | qualified: true of `dsh-daily-work`, and `dsh-ipython` adds one |
| `docs/DELETE-AUDIT.md:461-466` | preset named as `canary5\.agent-presets\…` | the in-repo path, with the runtime-directory defect named |
| `docs/DELETE-AUDIT.md:469` | "27 tools, including: …" | the full 28-tool list from a fresh install |
| `docs/DELETE-AUDIT.md:486-501` | "an IPython package has started"; "no `package.json`, no `lib/`, no `cordis.patch.yml`, no test file, and no export … cannot be loaded by any profile" | replaced with a component table showing each of those now present, plus the fourth-instance-of-the-defect-class note and an explicit statement of what is still unfinished |
| `docs/DELETE-AUDIT.md:564-576` | §3.7 table listing three present items | outcome column added: all three deleted |
| `docs/DELETE-AUDIT.md:578-588` | "Three separate mechanisms" | **Four**; the IPython bundle added as instance 4, plus a note separating the two reachable-but-unconsumed cases |
| `docs/DELETE-AUDIT.md:692-726` | "Its evidence hashes are already stale … 124 match, 3 do not" | refuted in place with the retraction and the G-VER-05 pointer |
| `docs/DELETE-AUDIT.md:728-737` | counts table with no identity | identity `ece4037a…`, the `offline_qualified`/`conditional` split, and the 13 named |
| `docs/DELETE-AUDIT.md:790-812` | in-flight table, incl. "`packages/dsh-ipython/` has three source files and no `package.json`" | what has since reached production, what is still unreachable, and what is gone |
| `docs/DELETE-AUDIT.md` §5b | *did not exist* | **added**: the delete/replace inventory (see §4) |
| `docs/DELETE-AUDIT.md:96-109` | §1 graph presented as current | marked as a `2d4534f` snapshot with the current numbers and the `R3-unwired` pointer |

**Corrections to claims this pass made and then had to withdraw** — recorded because
they are the same failure mode the project keeps finding:

1. An early draft of this pass wrote the **un-fixed** `pathname` form into
   `DELIVERY.md` as VERIFIED. It was wrong on Windows, and the same agent that owns
   `GAPS.md` independently found and fixed it as `G-FIX-13`.
2. This pass's **first** boot of the fresh install read
   `M12-deliverable-surface/surface.json`, which held a result produced by a
   different `DSH_HOME` — **another agent's run, read as mine.** It was caught only
   because a later run's `presetRoots` named a home I never created. That is
   `G-FIX-13`'s second defect. The remedy is applied throughout: every probe result
   cited in this pass was re-run into an R9-owned path and **its `presetRoots` were
   checked to name the home that was booted** (`surface-r9-verified-fresh-install.json`).
3. This pass **overwrote a tracked file outside its ownership**
   (`M12-deliverable-surface/surface.json`) by running the shared probe. It was
   restored from `git` byte-identically (sha256 `35ed03e2…`, no diff against HEAD)
   and the run's output was kept under `R9-delivery/` instead. Reported here rather
   than left for someone to discover.

---

## 4. Delete audit

The task asked whether the audit is current and whether every `disabled:` and every
replaced row appears. **It was not, and the inventory was missing entirely.** A new
**§5b** was added to `docs/DELETE-AUDIT.md` and is summarised here.

**Authoritative sources** (read directly, not summarised from prose):

| Patch | Active rows |
|---|---|
| `profiles/daily-candidate/cordis.patch.yml` | `subagent` (config override), `agent-presets` (config override) — and **no `insert:` at all** |
| `packages/dsh-daily-work/cordis.patch.yml` | `subagent` (config override) + 7 inserts: `daily-work-host`, `daily-web-search`, `daily-history`, `daily-work-tool-protocol-guards`, `daily-writers`, `daily-data-plane`, `daily-programmatic-scope` |
| `packages/dsh-ipython/cordis.patch.yml` | 1 insert: `ipython-kernel-host` |
| `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` | the shipped `standard` preset + exactly 2 rows: `daily-work-tools`, `ipython-tool` |

### Deleted: nothing. Replaced: nothing. Disabled: nothing new.

- **No stock row is removed, and a patch cannot remove one.** The dialect has no
  delete verb (`vendor/include/src/index.ts:77-100`). Every difference is an
  override, an insert, or a `disabled:` that leaves the row mounted and inert.
- **This project introduces zero `disabled:` rows.** `grep -c disabled` over all
  three patch files returns **0, 0, 0**. The six `disabled:` rows a reader will find
  are the **shipped** preset's own, inherited byte-identically by the copy:
  `tool-bash` (`!!js process.platform === 'win32'`), `tool-pwsh`
  (`!== 'win32'`), `tool-subagent-codex`, `tool-subagent-claude-code`,
  `tool-ralph`, `tool-plugin-manager`. **Verified by diff, not by reading: 35 added
  lines, 0 removed lines** against the pinned checkout's
  `presets/standard/agent.cordis.yml`.
- **Two rows are replaced in place** (config override, row still mounted):
  `subagent` — stock has **no `config` block**, so `maxActiveSubagents` defaults to
  8 and N=10 is unsatisfiable; both patches restate `10` / `maxDepth: 1`.
  `agent-presets` — the stock roster gains a deployment `roots` entry and
  `default: daily-standard`. **The shipped root is still included**
  (`includeShippedRoot: true` is restated, because a patch replaces the whole config
  object), which is why `standard`, `ptc`, `minimal` and `cordis` are all still
  listed beside `daily-standard`.
- **One thing WAS deleted, in the repository rather than the composition:** the
  duplicate `daily-work-host` insert. The profile patch and the package's bundle
  patch both declared it, so a bundle install would have registered the service
  twice. The bundle is now the sole owner. Part of G-FIX-12.
- **One file deleted from the working tree:** `packages/dsh-daily-work/sig-probe.mjs`
  (` D`). Its findings live in `M9.9-signal/`.

**Anything deleted that is not in the audit:** the two scaffolding test files
(`probe-m7.test.ts`, `spike.test.ts`) and the `ipython-preset-row.yml` fragment had
been deleted but were still listed as present. Now recorded as deleted in §3.7.
**Anything in the audit that no longer matches:** the four items above — the
`canary5` runtime preset path, the "27 tools" catalog, the "no `package.json`"
IPython claim, and the §1 import graph. All corrected.

---

## 5. Claims that could NOT be checked, and why

Honest list. None of these is a claim I am endorsing; each is a claim I could not
falsify or confirm in this pass.

1. **Any live-model claim.** `live_provider_budget_authorized` is `false` and no
   credential was read. Every claim about what a *model* does — the N=10 admission
   result's quality half, `A12`'s missing model turn, the paid halves of
   `ECO-07`/`ECO-08`/`UPG-07` — is unchecked here and must stay `BLOCKED_EXTERNAL`.
2. **The N=10 concurrency result (`C01` at T1).** Not re-run: it needs a live
   provider or a 10-child boot, and other agents were running suites. The gate row
   and `M3.2-N10-concurrency/` are on disk and were read, not re-executed.
3. **The SIGKILL durability result (`M4.1`).** Read and internally consistent
   (`SIGKILL`, six checks true); **not re-run**, for the same reason.
4. **The `corepack pnpm install` and `pnpm build` steps.** Not re-run. A rebuild
   would change `apps/cli/lib/bin.js`'s sha256, which is a lock input and would
   invalidate the deployment identity every other agent is currently citing. The
   artifact hash was verified against the lock instead.
5. **The full test suite's pass/fail state.** Not run — explicitly out of scope, and
   other agents were running it. Only `vitest list` (collection, no execution) was
   run: **1084 across 47 files at `a1d6e6d`**. Per-family pass counts are quoted in
   the docs from their own `tests.txt` and were not independently reproduced.
6. **The `tsc -p tsconfig.check.json` clean-exit claim.** Not re-run, same
   contention reason. The claim's *shape* (that `tsconfig.json` excludes tests and
   so cannot fail on them) was verified by reading both configs.
7. **`E01`/`E06` re-measurement.** Not re-run; the fixtures exist and the findings
   were read. They are `FAIL` and are not going to become PASS on this host, so
   re-running would only re-confirm a negative.
8. **Claims inside `docs/GAPS.md`, `docs/SECURITY.md`, `docs/INVARIANTS.md`,
   `docs/DSH_SEAMS.md`.** These are **not owned by this pass** and were not audited
   claim-by-claim. Three problems found in them are reported rather than fixed:
   - `docs/GAPS.md` still carries `G-SEAM-20` ("the shipped profile installs NO
     launch port") as **OPEN**, but `2d4534f` wired it and `README.md` says so.
     **Recommend the owner mark it RESOLVED or restate it as test-tier-only.**
   - `docs/GAPS.md` `G-FIX-12` says "Both directions are measured in
     `qualification/results/M12-deliverable-surface/`", but that directory holds a
     single file and the failure direction is not separately recorded there. The
     failure direction now exists at
     `R9-delivery/surface-r9-broken-pathname-form.json`. **Recommend the owner
     update the pointer.**
   - `docs/GAPS.md` G-FIX-13's quoted broken-path text is the escape-mangled
     rendering, which is the *other* defect (G-FIX-11). It does not affect the
     finding, only its reproduction text.
9. **`docs/INVARIANTS.md` is dated 2026-09-19 and still names gates by the old
   spec.** Its 48 invariants bind to `C07`, `D03` etc., which are old-spec ids with
   no new-spec counterpart. Whether that is a defect or intentional is a product
   decision, and the file is not owned by this pass.
10. **The `M12-deliverable-surface/surface.json` content.** It reports 28 tools and
    agrees with three other independent runs, so it is not contradicted — but the
    run it holds was produced by a `DSH_HOME` other than the one being booted, so
    **it is not evidence of the home it appears to describe.** Treated as
    corroborating, never as primary.
11. **Whether the two extension packages resolve in a *relocated* install.** The
    `link:` dependencies are absolute paths into this repository
    (`link:D:/DSH/work/dsh-native-daily/packages/...`), so a copy of the repo
    elsewhere, or a machine without that path, will not install. That is a real
    limitation of the current install shape and is stated in DELIVERY §2 Trap 5 as
    the reason the link must be absolute — but **the relocatable form was not
    built and was not tested.**

---

## 6. What is still honestly wrong with the tree

Stated so the verdict is not read as the only defect:

1. **Two `FAIL`s are unfixable on this host** (`E01`, `E06`). Not "not yet
   verified" — measured, and the seam has no read lever and no network vocabulary.
2. **`epoch` is inert.** The guard exists, is tested, and is unreachable.
   `record.ts` documents this in the schema itself. `SEC-06` is a `FAIL` for this
   reason.
3. **The rollback has never been exercised** — only rehearsed, with a fixture and a
   fake remote.
4. **The model-facing shell has not left the daily preset.** `pwsh` is in the
   catalog beside `ipython`.
5. **`ctx.dailyHistory` and the record's `continuation` field have no consumer.**
   Mounted/written and correct, called by nothing.
6. **No host-wide 30.** `maxActiveSubagents` is per-family; two roots each get a
   full pool. The host ledger in `capacity.ts` is the real cap, and it is a newer
   mechanism than the evidence the N=10 gate cites.
7. **The 112-case spec is entirely `NOT_RUN`.** Every number in the 104-case report
   describes a different architecture, and the two id sets are disjoint.

**The verdict, once more: `NOT_READY`, on the basis in §1.** Nothing in this pass
changed it, and nothing in this pass should be read as moving any gate toward PASS.
