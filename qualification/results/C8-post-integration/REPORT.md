# C8 — post-integration re-measurement at the current contract identity

**Slice:** the release gate's check 9 — *"0 of 61 assembled-product PASS case(s) carry
evidence stamped with the current identity."*
**Worktree:** `D:\DSH\work\wt-c8` @ branch `wt/c8`
**Build measured:** HEAD `93f88babaeea172fc3434cde6f4b838a0d861154`, tree
`30b242a5da4ebe31cb6f480ab8c23f490f4d53a7`, both packages rebuilt before any
measurement (`tsc -p` on `dsh-daily-work` and `dsh-ipython`, exit 0 each).

Every claim below is labelled `[measured]` (produced by a run recorded in this
directory) or `[read in source]` (read from the tree, not executed).

---

## 0. THE HEADLINE

**N = 31 of the 61 measured, M = 26 hold.** Five do not hold and are reported as
findings rather than folded into a green: **FS-06** (8 of 16 clauses fail because the
probe measures an object path the product replaced), **CMP-01** (3 of 10 clauses fail on
a probe race), **CMP-07** (2 of 7 clauses fail against deliberately-changed values),
**CMP-08** (1 of 16 clauses fails because a preset it names no longer exists), and
**IPY-06** (attempted; failed with `BROKER_FAILURE` under load).

**The check-9 blocker is NOT cleared, and cannot be by evidence.** The gate compares
evidence identity against the lock's `deployment.identity`, which is a **superseded**
value from a scheme V5 §14 replaced. Evidence stamped with the current contract
identity can never equal it. This is an architectural mismatch in the gate, not a
shortfall of measurement. **The gate change is the coordinator's decision and is not
made here** (§1.3).

---

## 1. THE IDENTITY FINDING

### 1.1 The current contract identity, established by REGENERATION

Not read from a filed manifest. A **fresh live boot** of this worktree's built product,
then the manifest computed from that observation:

```
node qualification/runners/run-p14-manifest.mjs \
  --home D:/DSH/home/c8 \
  --out  D:/DSH/work/wt-c8/qualification/results/C8-post-integration/observation.json
```
→ `checks_passed: 18/18`, `verdict: OBSERVED`, `port_released: true`.
Transcript: `p14-driver.txt`.

```
python qualification/runners/build-manifest.py \
  --from-observation qualification/results/C8-post-integration/observation.json --write
```
Transcript: `manifest-generation.txt`. Output:

| field | value |
|---|---|
| `RuntimeDeploymentIdentity` | `0fe2d373d073691fa72c6e08108f23ddd2b16ada61b049248db0d530866736a1` |
| `QualificationContractIdentity` | **`5bd8ee5b1809ad8dc4b70e63e8f1bf6b444c88b9e96b51a5d9a99d6c6b46efa4`** |
| `contract_id` | `trusted-local-v3.5bd8ee5b1809` |
| `identity_computable` | `True` (0 gaps, 0 problems) |
| project commit | `93f88babaeea172fc3434cde6f4b838a0d861154` |

Written to `qualification/results/trusted-local-v3.5bd8ee5b1809/build-manifest.json`.

`[measured]` The observation's own ownership guard passed: `presetRoots` names
`D:/DSH/home/c8/profiles/daily/presets/`, and all 9 extension rows resolve into
`D:/DSH/work/wt-c8/packages/...` — so the identity describes **this worktree's** build,
not another checkout's.

### 1.2 The gate's comparison value, and why it can never match

`release-gate.py:385-389` requires, for each assembled-product PASS case:

```python
any(isinstance(e, dict) and e.get("identity") == recorded for e in (c.get("evidence") or []))
```

`recorded` is `lock["deployment"]["identity"]` (`release-gate.py:220`).

| value | source | what it is |
|---|---|---|
| `533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb` | `compatibility.lock.json` → `deployment.identity` | **the gate's comparison value** |
| `152e5c45c4aef97ba986b917077849173a66585146b67032ec7be64472c39b78` | `helpers/rederive-identity.py` recomputation | the tree's value for the **SUPERSEDED** scheme |
| `5bd8ee5b1809ad8dc4b70e63e8f1bf6b444c88b9e96b51a5d9a99d6c6b46efa4` | `build-manifest.py --from-observation` | **the current contract identity** (this run) |
| `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461` | all 314 stamped filed entries | what the OLD evidence says |

`[measured]` `python helpers/rederive-identity.py` prints at the top of every run:

> THIS IDENTITY IS SUPERSEDED. V5 section 14 split it into:
> `compatibility.expected.json` (requirements; no digest of any file in this repo);
> BuildManifest (generated; `RuntimeDeploymentIdentity = H(canonical manifest)`);
> Result/evidence files bind to `QualificationContractIdentity`.

`[measured]` The manifest's own `_what_this_is` agrees: *"Result and evidence files bind
to the CONTRACT identity."*

**Consequence, stated plainly: check 9 compares against `533c8cb0…`, which is a
superseded value that no evidence can carry. Zero of 61 is the arithmetic outcome of a
comparison against a value that is not the current identity, not (only) a shortfall of
measurement. This run's evidence is stamped `5bd8ee5b…` because that is the identity
the architecture says evidence binds to.**

`[measured]` Corroborating evidence that the supersession is real and not a local
artifact: the filed manifests under `qualification/results/trusted-local-v3.5146ee996bea/`
and `.../trusted-local-v3.a091cb594902/` both carry
`runtime_deployment_identity: c969808e…` with contract identities `5146ee99…` and
`a091cb59…` respectively — three distinct contract identities across three runs, while
the lock's single value has not moved. `[measured]` The lock's identity ALSO differs
from the tree's own recomputation of that same superseded scheme (`533c8cb0…` recorded
vs `152e5c45…` recomputed, 2 inputs moved: `host_profile_digest`, `agent_preset_digest`),
so `release-gate.py`'s check 2 fails today as well.

### 1.3 The decision this report does NOT make

Which value check 9 should compare against — the lock's `deployment.identity`, the
contract identity, or a per-case "evidence is at the identity this candidate was
measured at" relation — is the coordinator's. This report supplies the measurement that
makes the question answerable: **the lock's value is superseded, the contract identity
is what evidence binds to, and the two can never be equal.**

---

## 2. WHAT WAS RE-MEASURED — THE HONEST DENOMINATOR

**N = 24 cases measured. M = 20 hold. 4 report defects/findings.**

All evidence is under `qualification/results/C8-post-integration/`. No filed evidence
was overwritten: `git status --porcelain` on `qualification/results/V2-composition/`,
`.../V3-ipython/`, `.../V6-recovery/` and `.../V7-fs/` is **empty** at commit time.

### 2.1 T3 — 9 of 9 measured, 9 hold

| Case | Exact command | Oracle clauses checked | Result | Evidence |
|---|---|---|---|---|
| **IPY-14** | `vitest run src/v3-spec-gates.test.ts -t "IPY-14"` (cwd `packages/dsh-ipython`) | new epoch + reason; state LOST; nothing replayed; Session survives and is usable | **HOLDS** | `tests-IPY-14.txt` |
| **REC-01** | `vitest run src/data-plane.test.ts -t "crash consistency"` | real SIGKILL between publication and reference commit; artifact is an orphan; no reader reports it delivered | **HOLDS** | `tests-REC-01-crash-consistency.txt` |
| **REC-02** | `-t "DAT-08"` + `-t "a corrupt or truncated artifact"` | missing object and corrupt/truncated object each give an explicit integrity failure naming the reference; never empty content | **HOLDS** | `tests-REC-02a-dat08.txt`, `tests-REC-02b-corrupt.txt` |
| **REC-03** | `node ../../qualification/runners/v6-rec03-crash-before-admission.mjs <out>` (cwd `packages/dsh-daily-work`) | no task published for the interrupted attempt; retry only for operations established as not taken effect | **HOLDS** | `rec03-crash-before-admission.json`, `rec03-run.txt` |
| **REC-04** | `-t "T9-B"`, `-t "D07"`, `src/effects.test.ts` | outcome recorded `unknown`; cell not replayed by default; unresolved effect named | **HOLDS** | `tests-REC-04a-T9B.txt`, `-b-D07.txt`, `-c-effects.txt` |
| **REC-05** | `vitest run src/faults.test.ts -t "requirement 11"` (cwd `packages/dsh-ipython`) | real `taskkill /F`: epoch advances, lost list visible, Session survives | **HOLDS** | `tests-REC-05-ipy.txt` |
| **REC-06** | `vitest run src/kernel-recovery.test.ts -t "recovery reports state honestly"` | `as-of`, `skipped`, `lost` each reported; full recovery not claimed | **HOLDS** | `tests-REC-06.txt` |
| **REC-07** | `-t "checkpoint restore accepts only explicitly safe formats"` | hostile checkpoint refused, format named, host never deserializes | **HOLDS** | `tests-REC-07.txt` |
| **REC-08** | `-t "unknown side effects stay quarantined"` | ambiguous call not auto-re-executed on reconnect | **HOLDS** | `tests-REC-08.txt` |

`[measured]` IPY-14's own numbers, verbatim from the run:

```
[V3-MEASURED] IPY-14 {"epochBefore":1,"epochAfter":2,"pidBefore":21424,"pidAfter":33900,
"pidReplaced":true,"generationReported":true,
"generationReason":"the kernel process is gone; see ...\\kernel.err",
"volatileStateLost":true,"reportedAsThrow":false,"modelTextMentionsNewEpoch":true,
"modelTextSaysLOST":true,"modelTextSaysNothingReplayed":true,
"sessionStillRegistered":true,"survivorReadBack":"ipy14_precious present: False"}
```

`[measured]` REC-03's control arm (the reason this is not an empty negative):
window arm `taskKeys: []`, `reserved: 0`, run still exists; control arm
`taskKeys: ["t1"]`, `reserved: 7`. Both children SIGKILLed and confirmed gone.

### 2.2 T4 — 3 of 3 measured, 3 hold

One real boot through the shared harness, foreign cwd `D:/DSH/src/dsh-src`, port bound
not guessed and verified released.

| Case | Oracle clauses checked | Result |
|---|---|---|
| **FS-01** | write outside the workspace SUCCEEDS; record states no confinement claimed (`fsSandboxMode` undefined); escalation fields `[]`; lock + spec say no write confinement | **HOLDS** (6/6) |
| **FS-02** | read outside the workspace through the native tool AND a Python cell both succeed and reach the SAME BYTES (digest compared) | **HOLDS** (3/3) |
| **FS-04** | each of symlink / hardlink / cross-boundary rename recorded SEPARATELY; non-refusals reported as findings; correctness half holds (no corruption, no silent mis-resolution) | **HOLDS** (7/7) |

Command: `node qualification/runners/v7-fs-driver.mjs` with
`V7_RESULT_DIR=.../C8-post-integration V7_HOME=D:/DSH/home/c8
V7_FIXTURE_ROOT=.../C8-post-integration/v7-fs-fixtures`.
Evidence: `v7-fs-run.txt`, `boot.json`, `VERDICT.json`, `transcript.txt`.
`[measured]` **39 of 47** checks pass; all 8 failures are FS-06 (§3).

### 2.3 T2 — 19 of 49 measured, 14 hold

`[measured]` Per-case clause tallies, read from the verdict JSONs (not from prose):

| Case | Driver | Clauses ok/fail | Verdict |
|---|---|---|---|
| **CMP-01** | `run-boot3-shell.mjs` (6/3) + `run-boot4-composition.mjs` (1/0) | **7 ok / 3 fail** | **FINDING** (§3.2) |
| **CMP-03** | `run-boot4-composition.mjs` | **4 ok / 0 fail** | **HOLDS** |
| **CMP-04** | `run-boot1-surface.mjs` | 2 ok / 2 fail | **ORACLE NOT MET** (§3.3) — already FAIL in the spec, not one of the 61 |
| **CMP-05** | `run-boot1-surface.mjs` | **3 ok / 0 fail** | **HOLDS** |
| **CMP-06** | `run-boot3-shell.mjs` (5/0) + `run-boot4-composition.mjs` (9/0) | **14 ok / 0 fail** | **HOLDS** |
| **CMP-07** | `run-boot4-composition.mjs` | **5 ok / 2 fail** | **FINDING** (§3.4) |
| **CMP-08** | `run-boot4-composition.mjs` (5/1) + `run-boot8-twin-preset.mjs` (10/0) | **15 ok / 1 fail** | **FINDING** (§3.5) — the literal stimulus is 10/10 |
| **CMP-09** | `run-boot4-composition.mjs` | **5 ok / 0 fail** | **HOLDS** |
| **CMP-10** | `run-boot4-composition.mjs` | **7 ok / 0 fail** | **HOLDS** |
| **CMP-11** | `run-boot1-surface.mjs` | **2 ok / 0 fail** | **HOLDS** |
| **CMP-13** | `run-boot1-surface.mjs` (3/0) + `run-boot3-shell.mjs` (2/0) | **5 ok / 0 fail** | **HOLDS** |
| **IPY-01..IPY-05** | `vitest run src/v3-spec-gates.test.ts -t "IPY-0"` | **5 passed** | **HOLD** |
| **FS-03** | `v7-fs-driver.mjs` | **5 ok / 0 fail** | **HOLDS** |
| **FS-05** | `v7-fs-driver.mjs` | **7 ok / 0 fail** | **HOLDS** |
| **FS-06** | `v7-fs-driver.mjs` | **8 ok / 8 fail** | **UNESTABLISHED** (§3.1) |
| **IPY-06** | `vitest run src/v3-spec-gates.test.ts -t "IPY-0"` | **1 FAILED** (`BROKER_FAILURE`, 66.5 s) | **NOT PASS** (§5) |

Commands and evidence:

| Command | Evidence |
|---|---|
| `node qualification/results/C8-post-integration/t2-drivers/run-boot1-surface.mjs` | `boot1-verdict.json`, `boot1-run.txt`, `boot1-transcript.txt` |
| `node qualification/results/C8-post-integration/t2-drivers/run-boot3-shell.mjs` | `boot3-verdict.json`, `boot3-run.txt`, `boot3-transcript.txt` |
| `node qualification/results/C8-post-integration/t2-drivers/run-boot4-composition.mjs` | `boot4-verdict.json`, `boot4-run.txt`, `boot4-transcript.txt` |
| `node qualification/results/C8-post-integration/t2-drivers/run-boot8-twin-preset.mjs` | `boot8-verdict.json`, `boot8-run.txt`, `boot8-transcript.txt` |
| `cd packages/dsh-ipython && vitest run src/v3-spec-gates.test.ts -t "IPY-0"` | `tests-T2-IPY-spec-gates.txt` |

`[measured]` The T2 driver copies under `t2-drivers/` are the ARCHIVED
`qualification/results/V2-composition/run-boot*.mjs` drivers with only the tree root,
home, and output paths rewritten to this worktree and this result directory. **The
check lists and oracle clauses are byte-for-byte the ones that produced the filed V2
verdicts** — no clause was weakened, added or removed.

---

## 3. EVERY FAILURE, CLASSIFIED — DEFECT vs PROBE ARTIFACT

The coordinator asked for each of the 8 FS-06 failures to be classified, plus the
mechanism for each genuine defect. I add the three non-FS-06 failures for the same
reason: none of them is a PASS and none may be counted as one.

### 3.1 FS-06 — 8 of 16 clauses fail. **The verdict is UNESTABLISHED; no product defect is proven.**

The root cause is a **layout change the probe has not caught up with, so the probe
measures a path the product no longer uses.**

`[read in source]` `packages/dsh-daily-work/src/artifacts.ts:1314-1321` records it
verbatim:

> THE OBJECT'S BYTES, NOT THE INDEX ENTRY. This resolved through `pathOf()` when this
> module owned a `root/objects/<2>/<sha>` layout, and **F4 replaced that layout with the
> mounted provider plus an `index/` metadata directory.**

`[measured]` The store root now contains `index/`, `objects/`, `store-cursor-key.json`,
`store-realm.json` — but the **real object bytes live in the mounted attachment
provider**, at `D:/DSH/home/c8/attachments/v1/file-objects/07/07d894c4…`. The
`objects/` directory under the store root is **empty of the real object**; the file the
probe finds there is one it wrote itself.

Per-failure classification:

| # | Failing check | Class | Why |
|---|---|---|---|
| 1 | *the store root is RELATIVE, and the record names what it resolves against* | **PROBE ARTIFACT** | `[measured]` `storeRootIsRelative = false`, `storeRoot = D:\DSH\home\c8\data-artifacts`. `[read in source]` `data-service.ts:688-696` now returns `homePath('data-artifacts')` — an **absolute** `$DSH_HOME`-anchored path — with the relative literal only as a step-3 fallback. The probe's own comment (`v7-fs-probe.mjs:605-607`) still describes the pre-fix behaviour ("falls back to the RELATIVE literal"). **The product got better; the probe's expectation did not move.** The oracle clause is still satisfied in substance (root resolves outside the workspace, and `storeRootResolvedAgainst` is recorded) — but as written the check asserts a relative root the product deliberately stopped producing. |
| 2 | *a workspace file with the artifact's own name does NOT change the store object* | **PROBE ARTIFACT** | `[measured]` `storeBytesUnchanged = true` and `storeStatAfterSameNameWrite.ok = true` — the store's own verdict is unchanged. The check also requires `objectOnDiskUnchanged`, which is `false` **only because `objectOnDisk` names a path that is not the object** (§ root cause above). The oracle clause ("the store's object is unaffected by the workspace write") **holds**; the conjunct that fails is the probe's stale path. |
| 3 | *the relative store path and the session-relative path are DIFFERENT files (recorded as a finding)* | **PROBE ARTIFACT** | `[measured]` `sameRelativeNameTwoFiles = true` — the finding **was** recorded. The check additionally requires `storeObjectUntouchedByRelativeWrite`, which is `false` for the same stale-path reason as #2. |
| 4 | *the store object is REACHABLE by an absolute path (the read succeeds)* | **PROBE ARTIFACT** | `[measured]` `objectReadFirst = {isError: true, code: "FS_NOT_FOUND"}` at `…\data-artifacts\objects\07\07d894c4…`. That path **does not hold the object**; the object is under `attachments/v1/file-objects/`. The probe builds the path from a layout the product replaced. |
| 5 | *the store object is IMMUTABLE in fact — the write is refused by the OS (EACCES)* | **PROBE ARTIFACT** | `[measured]` `objectModeOnDisk = {octal: "666", writableByOwner: true}` — at the stale path. `[measured]` The **real** object at `attachments/v1/file-objects/07/07d894c4…` is mode **`444`** (read-only), published by `[read in source]` `attachment-local/src/store.ts:291,372` (`await chmod(target, 0o400)`). So the immutability property **holds at the real object**; the probe measured the wrong file. |
| 6 | *the store object was NOT modified by the refused write* | **PROBE ARTIFACT** | `[measured]` `objectWasTampered = true` **at the stale path** — the probe's own `write` succeeded there because that file is a plain 666 file the probe itself created. The real object is 444 and was never addressed. |
| 7 | *FINDING — the read path does NOT detect tampering* | **PROBE ARTIFACT (finding unestablished)** | `[measured]` `readPathReturnedTamperedBytes = false`, `readPathThrewAnError = false`. The probe tampered the **stale path**, which the store does not read from, so `openRange` correctly returned the **original** bytes (`"V7-FS06 store-owned artifact payload…"`). The filed V7 run asserted the opposite; at this identity the tamper never reached the store's object, so **the finding is not established either way** and must not be cited as one. |
| 8 | *the EXPLICIT verify() DOES detect tampering* | **PROBE ARTIFACT** | `[measured]` `theExplicitVerifyDetectedTheTampering = false` — consistent with #7: nothing the store reads was tampered, so `verify()` correctly returned `true`. |

**Honest consequence, stated without softening.** At identity `5bd8ee5b…` **FS-06 is
NOT established**, and the reason is a probe/product layout divergence, not a proven
product defect. The probe measures `root/objects/<2>/<sha>`, a layout
`artifacts.ts:1314-1321` says F4 replaced with the mounted provider plus `index/`. So:

- **No genuine product defect is proven by these 8 failures.** Claiming one would be
  the same class of error as the filed run's original false-positive labels, in the
  opposite direction.
- **FS-06's verdict at this identity must be treated as UNESTABLISHED**, not PASS. The
  8 clauses that pass are real; the 8 that fail do not support a PASS and do not
  support a FAIL.
- The correct next step is a probe repair that resolves the object through
  `store.fileHostPath` / `attachments.fileHostPath` (`[read in source]`
  `artifacts.ts:1111,1168` — the product's own accessor) instead of synthesising
  `objects/<2>/<sha>`. **I did not make that change**: it changes what the instrument
  measures, and re-measuring with a repaired probe would be a different measurement
  that must be filed as such.

`[measured]` A related genuine finding, recorded because it survives the layout issue:
`reconcile` reports the just-published object as an **orphan**
(`{"orphans":["artifact:sha256:07d894c4…"],"integrityErrors":[]}`) — correct for a
`put` with no committed reference, and worth noting as the store behaving as designed.

### 3.2 CMP-01 — 3 of 10 clauses fail. **PROBE RACE, not a product defect.**

`[measured]` The three failures are all the same event:

```
FAIL the live loader audit reports ZERO inactive entries (mid-apply)
     [{"id":"hmr","name":"@deepseek-ai/dsh-hmr","disabled":false,"fiberState":1,"missing":[]}]
FAIL the probe's own activation-warning count is 0   -- 1
FAIL every assertion inside the shared probe passed  -- false
```

`[measured]` The **post-audit** snapshot — taken after the product's own
`auditStartupEntries` ran — reports `[]`, and `activationWarningLines: []`. The boot
output contains no `did not activate` line and no `waiting for service(s)` line.

`[read in source]` `fiberState: 1` is cordis's loading/pending state, and `hmr` is a
shipped row still settling at the mid-apply sample. The filed V2 run recorded
`inactiveEntries []` at the same checkpoint — the difference is **timing**, not
behaviour: whether the mid-apply sample lands before or after `hmr` settles.

**Class: probe race.** The oracle's operative clauses ("zero entries report
`did not activate`, `pending`, or `waiting for services`; the boot output contains no
warning line") are satisfied at the **post-audit** checkpoint and by the **absence of
the warning line** — both measured. A mid-apply sample of a still-loading row is not a
composition failure, and the filed run's own note says the mid-apply count was `[]`
that time. **The honest statement is: CMP-01's oracle is satisfied at the checkpoint
that matters, and one clause of the probe's mid-apply sample is timing-dependent.**

### 3.3 CMP-04 — oracle NOT met, and it is not repairable by measurement.

`[measured]` `toolCountAgentKey = 24`, `pwsh = false`. The oracle requires 28 and
`pwsh` present. `[measured]` The 24 names are recorded verbatim in
`boot1-verdict.json`.

`[read in source]` `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
**disables** `tool-subagent`, `tool-subagent-fork`, `workflow-ptc` and `tool-workflow`
on purpose (the comment block beginning "THE MODEL HAS NO CREATION SURFACE HERE"),
which removes `subagent`, `subagent_fork` and `workflow` from the catalog — exactly the
three names by which 27 became 24.

**Class: known, deliberate composition change; the oracle predates it.** This is the
same contradiction the filed V2 GATES.md §3.2 documents (CMP-04 vs CMP-13) and does not
re-open it. **I did not edit the oracle.** CMP-04 is not a PASS at this identity and is
not counted as one.

### 3.4 CMP-07 — 2 of 7 clauses fail. **PROBE EXPECTATION STALE, values deliberately changed.**

`[measured]` `subagent.maxActiveSubagents = 30` (check expects 10);
`agent-presets.includeShippedRoot = false` (check expects `true`).

`[read in source]` Both are **intentional** in this round's profile:
`profiles/daily-candidate/cordis.patch.yml:71` — `maxActiveSubagents: 30`, with the
comment "DSH's continuable pool size = the deployment's physical limit (V5 §8)"; and
`:149,220` — `includeShippedRoot: false`, "DIFFERENCE 1c (user-authorized)".

**Class: probe expectation stale against a deliberate change.** The **oracle itself
still holds**: "the dumped row carries every required key with its intended value, and
no unmentioned key has silently reverted to a schema default" — `[measured]`
`configKeys = ["maxActiveSubagents","maxDepth"]` and
`["default","roots","includeShippedRoot","includeUserRoot"]`, both keys present in each
row with no reversion. **The two failing clauses hardcode the pre-change intended
values.** CMP-07 is not counted as a PASS here because the probe's own clause says
otherwise; the coordinator owns whether to re-point those literals.

### 3.5 CMP-08 — 1 of 6 clauses fails, and it is a consequence of `includeShippedRoot: false`.

`[measured]` `presets: ["daily-standard", "standard", "daily-standard-2"]` where the
`standard` entry carries
`error: RemoteError: agent-presets: preset "standard" not found (available: daily-standard)`.

`[read in source]` `includeShippedRoot: false` (`cordis.patch.yml:149,220`) excludes the
shipped preset root by design, so the shipped `standard` preset is not mountable. The
check "the shipped standard preset does NOT mount ipython or work" can no longer be
evaluated: the preset does not exist in this composition.

**Class: probe expectation stale; the case's own oracle HOLDS.** `[measured]` The other
clauses pass — each agent's catalog contains exactly its own rows, and
`{"A":"cmp-run-A","B":"cmp-run-B"}` with `noCrossResolution` shows no module-scope state
crossing sessions. `[measured]` Corroborated independently by `boot8-verdict.json`
**10/10** for the literal stimulus (one composition file, two presets, identical in
their own rows).

---

## 4. HARNESS DEFECTS FOUND AND FIXED

Both produced **false findings in the green direction** — the failure mode this spec
exists to catch — so both are recorded rather than quietly repaired.

### 4.1 `v7-fs-driver.mjs` booted ANOTHER CHECKOUT's product

`[measured]` The first run of this driver from `wt-c8` reported:

```
probe_error: RemoteError: agent-presets: preset "daily-standard" failed to mount:
1 row(s) did not activate: daily-work-command (dsh-daily-work/command): never started
```

with `toolCount` 24 against the filed run's 27, and `subagent`/`subagent_fork`/`workflow`
all missing — i.e. the boot was executing the **main tree's** `dsh-daily-work`, whose
`lib/command-work.js` does not exist.

**Mechanism** `[read in source]`: `freshInstall()` copies the committed
`profiles/daily-candidate/package.json`, whose `link:` targets name
`D:/DSH/work/dsh-native-daily` **deliberately** (that literal is the needle
`helpers/new-writer.ps1:99` searches for). Overwriting the provisioned home's
`package.json` therefore **undoes the provisioning rewrite**, and every
`dsh-daily-work` row resolves a different checkout. This is the
G-SEAM-29 / G-SEAM-36 / G-SEAM-61 class.

**Fix**: re-apply the same rewrite to the installed copy, no-op when this tree *is* the
main tree. `v7-fs-driver.mjs` now records `linkTargetsRewritten` and `repoRoot`.

### 4.2 `v7-fs-probe.mjs` destroyed its fixture tree at a fixed path

`[read in source]` The probe calls `rmSync(WORKSPACE, {recursive: true, force: true})`
at the top of `apply`. A run at a **new** identity would therefore have deleted the
fixtures under the **filed** `qualification/results/V7-fs/` evidence.

**Fix**: `V7_FIXTURE_ROOT` parameterises the fixture root, **defaulted to the previous
literal** so a run that sets nothing behaves identically. This run used
`.../C8-post-integration/v7-fs-fixtures`.

### 4.3 An accidental overwrite, reverted

`[measured]` While bringing up the T2 drivers I ran them before redirecting their output
paths, overwriting `qualification/results/V2-composition/boot{1,3,4}-*.json` in **my own
worktree**. Detected by `git status --porcelain`, **reverted with
`git checkout -- qualification/results/V2-composition/` before any commit**, and the
drivers were redirected to write into `C8-post-integration/`. The commit's tree carries
the original filed bytes; `git status` on that directory is empty. Recorded because a
near-miss in this class is evidence about the process, not noise.

---

## 5. THE DENOMINATOR, STATED HONESTLY

| | count |
|---|---|
| Assembled-product PASS cases the gate requires (T2/T3/T4/T6) | **61** |
| Cases I re-measured at `5bd8ee5b…` | **31** |
| Cases whose oracle HOLDS | **26** |
| Cases measured whose oracle does NOT hold | **5** (FS-06, CMP-01, CMP-07, CMP-08, IPY-06) |
| Cases NOT measured | **30** |
| Cases carrying evidence the gate would accept | **0** — the gate compares `533c8cb0…` (§1.2) |

### Which of the 61 were NOT measured, and why

**T3: 0 unmeasured.** All 9 re-measured.
**T4: 0 unmeasured.** All 3 re-measured.

**T2: 30 of 49 unmeasured:** `CMP-12`; `IPY-07`, `IPY-09`, `IPY-10`, `IPY-11`, `IPY-12`;
`BR-01..BR-06`, `BR-08..BR-12` (11); `CAP-01..CAP-09`, `CAP-11..CAP-13` (12); `RES-01`.

| group | count | why not measured |
|---|---|---|
| **BR-01..BR-06, BR-08..BR-12** | 11 | Bridge family. Needs the R5 bridge driver and the `packages/dsh-ipython` bridge tests; outside this slice's bounded CPU budget. **NOT_RUN is not PASS.** |
| **CAP-01..CAP-09, CAP-11..CAP-13** | 12 | Capacity family. Needs the V8 capacity boot — a real 30-child storm, the most CPU-expensive family in the tree. Explicitly outside a bounded slice. **NOT_RUN is not PASS.** |
| **IPY-07, IPY-09, IPY-10, IPY-11, IPY-12** | 5 | Each has a targeted test (`faults.test.ts`, `lifecycle.test.ts`, `v3-ipython-boot.mjs`) that boots a real kernel. Not run: the IPY-06 attempt already consumed ~66 s on a loaded machine and further kernel boots were not affordable. **NOT_RUN is not PASS.** |
| **CMP-12** | 1 | Home-override visibility, needs `run-boot7-home-override.mjs` (two homes, two boots). Not run. **NOT_RUN is not PASS.** |
| **RES-01** | 1 | Needs the V10 research-observation chain. Not run. **NOT_RUN is not PASS.** |

**IPY-06 was ATTEMPTED and FAILED.** `[measured]` `tests-T2-IPY-spec-gates.txt`:

```
× IPY-06: only the matching reply and idle settle a cell
  > foreign frames are ignored AND COUNTED, and a restart mid-sequence is a new epoch
  66541ms
  → BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds
```

This is **the same failure the filed V3 GATES.md §3 already records as an open,
load-dependent finding** — "restart is unreliable under load ... a gate whose result
depends on machine load is a gate a reader cannot trust either way" — reproduced here at
~66 s with 8 sibling writers on the machine. It is **not a new defect and not a PASS.**
The other 5 tests in that same run passed (IPY-01..IPY-05).

**Nothing in this list is counted as a PASS.** The 31 measured / 26 holding figure
includes only cases I actually drove, and the 5 non-holding cases are named above
rather than absorbed.

---

## 6. WHAT I COULD NOT ESTABLISH

1. **The gate's check 9 cannot be satisfied by any evidence** while it compares against
   the lock's superseded `deployment.identity` (§1.2). Resolving this is a gate change
   the coordinator owns.
2. **FS-06's true verdict at this identity.** The 8 failing clauses measure a path the
   product replaced; neither PASS nor FAIL is supported (§3.1). A repaired probe
   resolving through `attachments.fileHostPath` is required, and re-measuring with it
   would be a new measurement.
3. **IPY-06's restart reliability.** Reproduced as a load-dependent failure; not
   isolated to a cause. This run did not capture a bind error at the moment of failure.
4. **The 30 unmeasured T2 cases** (§5). Every one is NOT_RUN, and NOT_RUN is not PASS.
5. **`--check-expected` reports one real problem** — the pinned checkout is dirty
   (`M packages/deliverables/workspace-changes/src/index.ts`), which ID-06's oracle
   forbids. `[measured]` `build-manifest.py --check-expected` exits 1 with exactly that
   one problem and no others. That is a separate slice; noted, not touched.
6. **Whether the identity should be regenerated again after this commit.** The manifest
   binds to commit `93f88bab…`; this commit adds evidence files, which are inputs of
   neither hash (by design, `build-manifest.py:966-969`), so the contract identity
   should be stable — but that is a claim about the design, not something I re-verified
   by regenerating after the commit.

---

## 7. FILES

| path | what |
|---|---|
| `p14-driver.txt`, `observation.json`, `transcript.txt` | the fresh boot the identity came from |
| `manifest-generation.txt` | the identity computation, both values |
| `qualification/results/trusted-local-v3.5bd8ee5b1809/build-manifest.json` | the written manifest |
| `tests-IPY-14.txt`, `tests-REC-0*.txt` | T3 runs |
| `rec03-crash-before-admission.json`, `rec03-run.txt` | REC-03 window + control arms |
| `v7-fs-run.txt`, `boot.json`, `VERDICT.json`, `transcript.txt` | T4 boot, 47 checks |
| `boot1-*.json`, `boot3-*.json`, `boot4-*.json`, `boot8-*.json`, `*-run.txt` | T2 boots |
| `t2-drivers/*.mjs` | the archived V2 drivers, paths rewritten only |
| `tests-T2-IPY-spec-gates.txt` | IPY-01..05 pass, IPY-06 fails |

**Spec files, `compatibility.lock.json` and `release-gate.py` were NOT edited. No
verdict was changed. No oracle was edited. No test was skipped to obtain a PASS.**
