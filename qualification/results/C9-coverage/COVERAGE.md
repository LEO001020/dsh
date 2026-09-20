# C9 — a READ-ONLY coverage inventory of the 112-case acceptance spec

> **What this file is.** A classification of the evidence that EXISTS against the 112 mandatory
> acceptance cases, produced by reading artifacts. **No test suite was run.** Nothing here fixes
> anything, edits a spec, or promotes a case. The authority
> (`delivery/acceptance-spec.json`) still records all 112 as `NOT_RUN` with empty `evidence`,
> and its `AUDIT_STATUS.json` still says `new_acceptance_status: "ALL_NOT_RUN"` and
> `production_qualification: "NOT_READY"`. **This inventory changes neither.**

**Authority:** `C:\Users\hzq00\Downloads\DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20\dsh-audit-2026-09-20\delivery\acceptance-spec.json` (112 cases).
The repository copy `qualification/specs/acceptance-spec.json` was verified to carry the SAME 112 ids
with zero content differences.

**Machine-readable twin:** `qualification/results/C9-coverage/coverage.json`.

---

## The four classes, and the rule that decides them

| class | meaning |
|---|---|
| **COVERED** | An existing artifact exercises this case's stimulus AND checks its oracle. |
| **PARTIAL** | Evidence bears on part of the case. The unaddressed clause is named per row. |
| **UNCOVERED** | No artifact exercises the stimulus. |
| **BLOCKED_EXTERNAL** | Cannot run without something unavailable (live provider budget, a second execution world). |

**THE RULE THAT MATTERS MOST.** This project's most-recorded defect class is *"mechanism
implemented, unit-tested, correct - while nothing in the product calls it."* It is recorded twelve
times, most recently as G-SEAM-34 (the IPython bridge) and G-SEAM-21 (the epoch guard). So:

> **A case covered ONLY by a unit test is NOT COVERED. It is at most PARTIAL.**

And evidence strength must match the tier's demand: an `integration` case needs a real assembled
product; a `fault_injection` case a real fault; a `security` case a real boundary; an `evaluation`
case a real measurement. A test that mounts the module by hand proves the MODULE works and proves
nothing about the product - the project states this itself in `r5-product-bridge.test.ts`.

---

## 1. Summary

| tier | total | COVERED | PARTIAL | UNCOVERED | BLOCKED_EXTERNAL |
|---|---|---|---|---|---|
| integration | 72 | 57 | 9 | 3 | 3 |
| fault_injection | 16 | 6 | 8 | 2 | 0 |
| security | 16 | 11 | 4 | 0 | 1 |
| evaluation | 8 | 2 | 4 | 0 | 2 |
| **ALL** | **112** | **76** | **25** | **5** | **6** |

### By family

| family | total | COVERED | PARTIAL | UNCOVERED | BLOCKED_EXTERNAL |
|---|---|---|---|---|---|
| DEP | 8 | 7 | 0 | 0 | 1 |
| IPY | 8 | 7 | 0 | 0 | 1 |
| BRG | 8 | 8 | 0 | 0 | 0 |
| DAT | 8 | 8 | 0 | 0 | 0 |
| WEB | 8 | 8 | 0 | 0 | 0 |
| HIS | 8 | 8 | 0 | 0 | 0 |
| REC | 8 | 5 | 3 | 0 | 0 |
| SEC | 8 | 4 | 3 | 0 | 1 |
| CAP | 8 | 2 | 6 | 0 | 0 |
| UI | 8 | 3 | 2 | 3 | 0 |
| VER | 8 | 7 | 1 | 0 | 0 |
| ECO | 8 | 2 | 4 | 0 | 2 |
| RES | 8 | 1 | 5 | 2 | 0 |
| UPG | 8 | 6 | 1 | 0 | 1 |

### The 30-child capacity flag

**A run with fewer children does NOT satisfy a 30-child oracle.** Eight cases name 30 explicitly:

`CAP-01`, `CAP-05`, `CAP-06`, `CAP-07`, `CAP-08`, `UI-01`, `RES-05`, `UPG-07`.

**No case in this repository has been run with 30 real children.** The cap boundary is reached
with **29 arithmetic reservations plus ONE real creation call** (`V8-capacity/GATES.md`), and V8's
own limitations section states: *"A reader must not read `30 real children were refused` out of this
file."* `CAP-06` is the one case where the oracle's N IS the N used (target 30 with only 2 ready),
but its children run on a controlled local provider route. `RES-05` is entirely UNCOVERED: the
31-kernel RSS measurement needs 30 real children, and M12 records it as blocked on the same budget.

---

## 2. Every case, one row each

Columns: **id | tier | class | artifact(s) that bear on it | the unaddressed clause | what is missing.**
Rows are in spec order. `-` in the last two columns means nothing is outstanding.

### DEP

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **DEP-01** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-01; M0.4-first-toolcall/A03-first-toolcall.txt; M8.5-c2-real-boot/e2e-tool.json; M0.6-launcher-identity/A03-launcher-identity.txt; V1-identity/ID-01-run.txt | The module-graph clause is fully established only in V1-identity ID-01, at a DIFFERENT identity (0a0996f3), and it FAILS there: 1 of 223 @deepseek-ai specifiers (dsh-attachment-local/src/store.ts) resolves to SOURCE not lib/, and Node 24 type-strips it so it runs. | A module-graph re-run at THIS identity. |
| **DEP-02** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-02; packages/dsh-daily-work/src/dep-gates.test.ts | - | Nothing. |
| **DEP-03** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-03; typecheck-errors.txt; declared-vs-imported.txt; S10-id05/* | - | 12 imported-but-undeclared DSH peers (a real-install hazard, recorded). |
| **DEP-04** | integration | **BLOCKED_EXTERNAL** | M-DEP-SEC-UPG/FINDINGS.md DEP-04 | The whole case: no SSH execution world is mounted, so no second world exists for a path to be mis-resolved against. | A first-party SSH execution world + dedicated Linux VM. Provisioning, not budget. |
| **DEP-05** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-05; V2-composition/boot5-6-failure-arms.json | - | Nothing. |
| **DEP-06** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-06; dep-gates.test.ts (a REAL second Node process); homelock.test.ts | - | Nothing material. |
| **DEP-07** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-07; dep-gates.test.ts; homelock.test.ts | - | Nothing material. |
| **DEP-08** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md DEP-08; typecheck-errors.txt | - | Nothing: the injected error makes tsc -p tsconfig.check.json exit non-zero. |

### IPY

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **IPY-01** | integration | **COVERED** | V3-ipython/run-v3-spec-gates.txt (IPY-01) | The kernel half is driven through KernelService.runCell - the product own service method, but on a ctx the TEST assembled. The tool row is separately established at a real boot by IPY-09 and R5-product-bridge. | An assembled-product run of the same cell through the model-facing tool. |
| **IPY-02** | integration | **COVERED** | V3-ipython/run-v3-spec-gates.txt (IPY-02) | Same ctx-assembly boundary as IPY-01. | A product-path run of the two-cell sequence. |
| **IPY-03** | integration | **COVERED** | V3-ipython/run-v3-spec-gates.txt (IPY-03); R5-bridge (native tool awaited from a real cell) | Nothing material. | Nothing. |
| **IPY-04** | integration | **COVERED** | V3-ipython/run-v3-spec-gates.txt (IPY-04) | Same ctx-assembly boundary. | Nothing material. |
| **IPY-05** | integration | **COVERED** | V3-ipython/run-v3-spec-gates.txt (IPY-05) | Same ctx-assembly boundary. | Nothing material. |
| **IPY-06** | integration | **COVERED** | V3-ipython/run-v3-spec-gates.txt (IPY-06); M5-lifecycle/PROBE-FACTS.md fact 3; experiment-restart-analysis.md | Nothing material: foreign frames are ignored AND counted, and a stray kernel_info_reply is a measured fact. | Nothing. |
| **IPY-07** | integration | **COVERED** | V3-ipython/run-faults.txt (requirement 8); M11-ipython/FINDINGS.md req 8; M5-lifecycle/PROBE-FACTS.md fact 8 | The authority oracle PERMITS this: "when uncertain mark unknown and reset". The await-suspended arm does not settle (20.15 s, then 10.07 s more on a second interrupt) and is reported as unknown + reset + epoch advance. It is NOT a graceful KeyboardInterrupt, and no evidence file claims one. | A graceful interrupt for an await-suspended cell - a Windows platform limit, not a budget item. |
| **IPY-08** | integration | **BLOCKED_EXTERNAL** | V3-ipython/GATES.md row IPY-08 (no evidence file exists) | The whole case: a real continuable-child activation end. | An authorized live model provider (live_provider_budget_authorized=false). Must never be faked. |

### BRG

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **BRG-01** | integration | **COVERED** | R5-bridge/RESULTS.md + composition-tier.json (a real `daily` boot); packages/dsh-ipython/src/r5-product-bridge.test.ts (24/24); M2-scope/FINDINGS.md (the scope route); V4-bridge/v4-bridge-probe.json + v4-bridge-approval-probe.json | The PTC/`run_code` route and the IPython route are each measured against the direct route, but the three-way comparison of the SAME tool through all three in ONE run is assembled from two evidence sets rather than one. R5 closed the "nothing starts the bridge" defect (G-SEAM-34): `new BridgeServer` is now constructed at kernel-plugin.ts:1255. | A single run exercising all three routes on one tool. |
| **BRG-02** | integration | **COVERED** | R5-bridge/RESULTS.md; r5-product-bridge.test.ts; V4-bridge/v4-bridge-probe.json (revocation mid-cell: first:ok -> revoke -> second ERROR UNKNOWN_TOOL) | The R5 product test proves mid-cell revocation through the tool, but the "does not rest on a catalog captured at cell start" clause is asserted on the bridge route while the product test uses the tool route; both are measured, in different files. | One run proving both clauses on the same route. |
| **BRG-03** | integration | **COVERED** | R5-bridge/RESULTS.md; r5-product-bridge.test.ts; V4-bridge/v4-bridge-probe.json (CELL_TYPE dict, CELL_IS_ARTIFACT False) | Nothing material. | Nothing. |
| **BRG-04** | integration | **COVERED** | R5-bridge/RESULTS.md; r5-product-bridge.test.ts; M2-scope/FINDINGS.md (executions === 1, post-policy reference) | Nothing material. | Nothing. |
| **BRG-05** | integration | **COVERED** | R5-bridge/RESULTS.md; M2-scope/FINDINGS.md BR-05 (a sweep of EVERY object in the store asserts the secret is absent); V4-bridge/v4-bridge-probe.json | Nothing material. | Nothing. |
| **BRG-06** | integration | **COVERED** | R5-bridge/RESULTS.md (concurrent Python submission SERIALIZES); M2-scope/FINDINGS.md BR-06 (many concurrent wrapped calls, re-entrancy many levels deep); V4-bridge/v4-bridge-approval-probe.json (12 concurrent at maxParallel 4, observedMaxConcurrency 4) | Nothing material. | Nothing. |
| **BRG-07** | integration | **COVERED** | R5-bridge/RESULTS.md; r5-product-bridge.test.ts (R5-BR-07: dispositions, the half that was missing - 24/24, incl. `settled`/`cancelled`/`abandoned-unstarted`/`handed-to-jobs` with a job id) | The V4-bridge FAIL was the pre-R5 state: the bridge route had a drain but no disposition vocabulary. R5 added it, and the durable ledger row now carries disposition/jobId/closeReason. The one clause NOT reachable in the default composition is `handed-to-jobs`, because no jobHandoff is configured - the arm is implemented and its ledger rule is tested directly, but the production wiring for a real handoff is a later slice. | A configured jobHandoff in the shipped composition to exercise `handed-to-jobs` end to end. |
| **BRG-08** | integration | **COVERED** | R5-bridge/RESULTS.md (additionalContexts and concludeTurn reach the OUTER ipython execution, in subcall order); r5-product-bridge.test.ts; M2-scope/FINDINGS.md BR-08 | Nothing material. | Nothing. |

### DAT

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **DAT-01** | integration | **COVERED** | V5-data/GATES.md DATA-01; tests-data-plane.txt; v5-data-probe.json (source and recovered sha256 equal; READ_MAX_LINE_LENGTH=2000 recorded for contrast) | Nothing material. | Nothing. |
| **DAT-02** | integration | **COVERED** | V5-data/GATES.md DATA-02 (32 MiB / 512 pages; projection 399 B in-process, 429 B real CPython, 437 B real ipykernel); tests-data-plane.txt; v5-data-probe.json | No `data.*` tool row exists, so no cell can reach the data plane as a native call: `cellReachedDataPlane false` and a cell `import data` fails with ModuleNotFoundError. The page walk is HOST-driven. The oracle asks for a cell to consume 512 native pages; that exact shape is not reachable. | A mounted `data.*` tool row so a cell can drive the page walk itself. |
| **DAT-03** | integration | **COVERED** | V5-data/GATES.md DATA-03 (5532 bytes, 120 records, 10 page sizes, no U+FFFD); tests-data-plane.txt; v5-data-probe.json | Nothing material. | Nothing. |
| **DAT-04** | integration | **COVERED** | V5-data/GATES.md DATA-04; tests-data-plane.txt (the mock is the only mock in the file and is labelled, because a correct provider cannot return a repeated cursor) | The stimulus is a MISBEHAVING provider, so a mock is the only way to produce it. The mock is labelled as such, which the oracle permits. | Nothing material. |
| **DAT-05** | integration | **COVERED** | V5-data/GATES.md DATA-05 (captured b778c9b5... vs rewritten source 42bb697d...); tests-data-plane.txt; v5-data-probe.json | Nothing material. | Nothing. |
| **DAT-06** | integration | **COVERED** | V5-data/GATES.md DATA-06 (8 pages cost 524288 bytes; one linear 4194304-byte index scan; 5 repeated reads scanned 944445 vs 20480) | Nothing material. | Nothing. |
| **DAT-07** | integration | **COVERED** | V5-data/GATES.md DATA-07 (canonical 900 read by a real CPython process; renderer keeps 250 of 900; real ripgrep); tests-data-plane.txt | RECORDED DEVIATION: at the raw cap the product THROWS `SearchError`/`SEARCH_RAW_OUTPUT_OVERFLOW` rather than returning a partial-marked descriptor. The oracle says "backend raw cap仍标partial". Both substantive requirements hold, but a reader requiring the literal partial marking should read this as a deviation. | A partial-marked descriptor at the raw cap instead of a throw. |
| **DAT-08** | integration | **COVERED** | V5-data/GATES.md DATA-08 (quota, orphan, missing, corruption and checkpoint arms, each with its stage and store state); tests-data-plane.txt; v5-data-probe.json | Nothing material. | Nothing. |

### WEB

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **WEB-01** | integration | **COVERED** | V10-research-obs/RES-01-boot-chain.json (res04Truncation, built from a real capped fetch through the SHIPPED provider); M7-history/FINDINGS.md WEB-01; OBS-history-web.txt | The TRUNCATION record is built through the shipped provider against a real socket; the SEARCH retrieval link is proven against a loopback server written to the port dialect, not a live search provider (no credential configured). That limit is named in RES-01, not hidden. | A live search credential (G-WEB-01/G-WEB-03) - the ported provider is mounted but NOT selected: `web.searchProvider: "deepseek-official"` vs the ported `id: "daily-search"`. |
| **WEB-02** | integration | **COVERED** | M7-history/FINDINGS.md WEB-02; OBS-history-web.txt (uncursored top-10 is mayBeMore unknown; only a seam cut is true; the model-facing text says not an exhaustive search) | Nothing material. | Nothing. |
| **WEB-03** | integration | **COVERED** | M7-history/FINDINGS.md WEB-03; OBS-history-web.txt; V10 GATES RES-05 | The HTML->markdown converter is INJECTED: the real converter is turndown+gfm in packages/web/tool-web/src/fetch.ts, which is not a package export. So this proves the raw/derived SEPARATION and the FAILURE behaviour, not turndown own output on malformed markup. | An exportable real converter, or a fixture carrying turndown output. |
| **WEB-04** | integration | **COVERED** | M7-history/FINDINGS.md WEB-04; OBS-history-web.txt; V5-data (the artifact-plane half, DATA-06 real) | Nothing material. | Nothing. |
| **WEB-05** | integration | **COVERED** | M7-history/FINDINGS.md WEB-05 (a real loopback server that ignores Range and answers 200; four separate refusals); OBS-history-web.txt | Nothing material. | Nothing. |
| **WEB-06** | integration | **COVERED** | V10-research-obs/RES-01-boot-chain.json (citationLink: located span, bytes at those offsets checked against the artifact, snippet refusal, untrusted wrap); OBS-history-web.txt; M7-history/FINDINGS.md WEB-06 | Nothing material. | Nothing. |
| **WEB-07** | integration | **COVERED** | V10-research-obs/RES-01-boot-chain.json; OBS-history-web.txt (every injection attempt recorded as a finding with the text verbatim; no field in the untrusted record could carry authority); M7-history/FINDINGS.md WEB-07 | Nothing material. | Nothing. |
| **WEB-08** | integration | **COVERED** | M7-history/FINDINGS.md WEB-08 (a real 64 MiB deflate bomb stopped at the bound by streaming); OBS-history-web.txt; V10 RES-02-03-vocabulary.txt (shipped extractPdfText outcomes: text/empty/budget-exceeded/decode-error) | DSH ships NO PDF extractor at all, so the PDF-outcome CLASSIFICATION is proven against the shipped vocabulary while the streaming decompressor is exercised against a real compression bomb. A real PDF parse is not claimed. | A shipped PDF extractor (upstream does not provide one). |

### HIS

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **HIS-01** | integration | **COVERED** | M7-history/FINDINGS.md HIS-01 + boot-probe.json (foreignReadRefused true, HISTORY_SESSION_UNAUTHORIZED, refused BEFORE any observation runs); OBS-history-web.txt (9 tests); R11-history/FINDINGS.md | The boot probe proves the refusal in a composed host, but the composed host is the CANARY home (D:/DSH/home/canary5), not a user daily home. Also recorded: `ctx.dailyHistory.history(caller)` has ZERO product consumers, so the plane is mounted and authorized while nothing in the product calls it. | A product consumer of the history plane; a boot from a real daily home. |
| **HIS-02** | integration | **COVERED** | OBS-plane-boot.json (obs02WatermarkPinned: pinnedScanExcludedAppended, watermarkUnchangedAcrossPages, reopenedSeesAppended, generationAdvanced); OBS-02-05-t2-boot.txt; OBS-history-web.txt; M7-history/FINDINGS.md | Nothing material. | Nothing. |
| **HIS-03** | integration | **COVERED** | OBS-plane-boot.json (obs03OversizedEvent: 200203 bytes, 4 segments, digestIsHex64, complete false, recovery authorized-refetch, segmentsArmCarriesNoEventBody, segmentListIsBounded); OBS-history-web.txt | Nothing material. | Nothing. |
| **HIS-04** | integration | **COVERED** | OBS-history-web.txt (100-page traversal at ONE log read, replayCounter total 1, byte-level measurement); OBS-plane-boot.json (obs04Replay, controlHasTeeth true); M7-history/FINDINGS.md | The 100-page traversal is a T1 measurement. The T2 confirmation in the composed host ran at 9 pages, because that is the whole stored session in a freshly booted host. The oracle names 100 pages; the T2 arm does not reach it. | A T2 host with >=100 pages of history. |
| **HIS-05** | integration | **COVERED** | OBS-plane-boot.json (obs05Visibilities: threeSetsAreDisjoint, unionAccountsForEveryStoredEvent, refusingToProjectWithoutConsuming); OBS-history-web.txt; M7-history/FINDINGS.md | Nothing material. | Nothing. |
| **HIS-06** | integration | **COVERED** | M7-history/FINDINGS.md HIS-06; OBS-history-web.txt (both versions present with their own sources and a supersedes link) | HIS-07-adjacent limit: this is a property of this code, not of the whole system. Whether every other consumer consults only authorityOf is not asserted. | Nothing material. |
| **HIS-07** | integration | **COVERED** | M7-history/FINDINGS.md HIS-07 (authorityOf reads `author` and nothing else; a model statement with [trusted,admin,root] keeps `claim` authority); OBS-history-web.txt | Recorded limit: it is a property of THIS module. Whether every other consumer in a future deployment consults only authorityOf is not something this milestone can assert. | Nothing material. |
| **HIS-08** | integration | **COVERED** | OBS-06-index-rebuild.txt; probe-obs06-index.mjs (the index directory deleted, canonical root enumerated, same answer rebuilt); OBS-history-web.txt; M7-history/FINDINGS.md | Nothing material. | Nothing. |

### REC

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **REC-01** | fault_injection | **COVERED** | V6-recovery/GATES.md REC-01; tests-crash-consistency.txt (real SIGKILL between artifact publication and the Session reference commit: 1 orphan, 0 integrity errors, object verified, exitCode 1) | Nothing material: the fault is a real SIGKILL, which is what a fault_injection tier demands. | Nothing. |
| **REC-02** | fault_injection | **COVERED** | V6-recovery/GATES.md REC-02; tests-dat08.txt (a referenced MISSING object raises artifact-integrity-error, never an empty string, 5/5); tests-integrity.txt (an object REPLACED in place at the same length and one TRUNCATED below declared bytes both raise, with an INTACT control, 3/3) | Nothing material. | Nothing. |
| **REC-03** | fault_injection | **COVERED** | V6-recovery/GATES.md REC-03; rec03-crash-before-admission.json (SIGKILL after createRun and before admit -> taskKeys [] and reserved 0; the CONTROL arm WITH admit killed at the same point -> taskKeys [t1], reserved 7; both children SIGKILL, liveness re-probed, 7/7); tests-durability-records.txt (D03 REAL KILL, 25/25) | Nothing material: the control arm is what makes this a measurement rather than a claim. | Nothing. |
| **REC-04** | fault_injection | **COVERED** | V6-recovery/GATES.md REC-04; tests-T9-A-B.txt (a lost reply that MAY have committed is reconciled by QUERY with exactly ONE transport invocation across 2x perform + 1x reconcile; an adapter that is neither keyable nor queryable is NOT RUN AT ALL, 0 invocations, recorded unknown); tests-effects.txt (48/48); tests-durability-records.txt D07 (REAL KILL); tests-ipy12-no-replay.txt | One clause is mechanism-only: the PRODUCT path quarantines a possibly-successful effect, and the reconciliation producer is the part R9-recovery-topology found has no production call site. The `unknown` semantics and the no-replay rule are measured; the end-to-end reconciliation through a real product settlement path is not. | A production settlement entry point (G-SEAM-24: no production caller writes a terminal task state). |
| **REC-05** | fault_injection | **COVERED** | V6-recovery/GATES.md REC-05; tests-kernel-death.txt (a real `taskkill /F` on the kernel pid yields a new epoch, volatileStateLost true, previousEpoch equal to the old epoch, a truthy reason, and a replacement kernel that is usable and EMPTY, 2/2); tests-restart-loss.txt (9/9) | Nothing material. | Nothing. |
| **REC-06** | fault_injection | **PARTIAL** | V6-recovery/GATES.md REC-06; tests-recovery-report.txt (5/5: checkpointAsOf, restored, lost, skipped, environmentChanged and unresolvedEffects are separate fields; the as-of is reported EVEN WHEN NOTHING WAS RESTORED; the scope statement says not full session recovery) | The evidence file states it itself: the module carrying this (kernel-lifecycle.ts) is UNREACHABLE from production, so this is the MECHANISM, not a product property. Verified independently in this inventory: `node qualification/runners/import-graph.mjs packages/dsh-daily-work` lists src/kernel-lifecycle.ts under UNREACHABLE non-test modules with non-test importers (NONE). | A production importer for kernel-lifecycle.ts, or the property restated on a reachable module. |
| **REC-07** | fault_injection | **PARTIAL** | V6-recovery/GATES.md REC-07; tests-hostile-checkpoint.txt (every pickle-family format refused BY NAME; a pickle disguised as .json refused ON ITS BYTES; an object-dtype array refused from the REAL .npy header; truncated arrays, self-disagreeing sizes, the zip-bomb bound and an archive lying about its sizes each refused; a real .npz of safe arrays accepted as the control) | Same reachability limit as REC-06: REFUSED_FORMATS lives in kernel-lifecycle.ts, which the import graph shows has no non-test importer. The refusals themselves are thorough and real; the product does not reach them. | A production importer for the hostile-checkpoint refusal. |
| **REC-08** | fault_injection | **PARTIAL** | V6-recovery/GATES.md REC-08; tests-quarantine-reconnect.txt (4/4: onTransportReconnect returns reexecuted [] and ambiguousCells [ambiguous]; the transport dispatched list is unchanged; the quarantine is STILL IN PLACE; a quarantine clears only through an explicit evidenced resolution) | The evidence file states it itself: kernel-lifecycle.ts is unreachable from production, so this is the MECHANISM. Additionally the stimulus names an SSH/IPC disconnect, and this deployment has no SSH execution world (see DEP-04) - the reconnect route exercised is in-process. | A production importer, and an SSH/IPC transport to disconnect. |

### SEC

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **SEC-01** | security | **PARTIAL** | M-DEP-SEC-UPG/FINDINGS.md SEC-01; M9.3-security-denial/FINDINGS.md E01; V7-fs/GATES.md FS-01/FS-02; gates.json E01 FAIL; upg-gates.test.ts | The oracle demands BOTH paths unreachable. MEASURED: a confined child READS a file outside the workspace root verbatim, exit 0, under BOTH read-only and workspace-write, and a fabricated fake-home/.dsh/credentials.json is likewise readable; a real Python cell read the same outside bytes (sha256 dbe5b665...). The WRITE boundary does hold (outside write EPERM, control asserted), which is why the honest statement is that this is a durability property, not a confidentiality one. Structural: SandboxPolicy adds exactly ONE thing to SandboxExecutionPolicy - a narrowed mode - so there is NO read lever, and ConfinedArgv cannot even OBSERVE a read denial. | An OS or VM boundary outside the runner (a Linux execution VM with read isolation). No configuration of this seam can provide it. This is why the audit own remedy is a dedicated Linux VM. |
| **SEC-02** | security | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md SEC-02; M9.19-control-plane/FINDINGS.md; control-plane.test.ts; R4-authorization/report-after.json | The model reaches things through tools and `tools.schemas(agent)` is the exact catalog offered: 27 tools, `exposedAsTool: []`, all 23 declared surfaces checked, zero exposed. `ctx.terminalController` is never called and its own module header documents unrestricted allocation. The loopback facts are cited with a CORRECTION: the index route is auth-fenced, NOT Host-fenced, so the rebinding defence is an /api property rather than server-wide. | Nothing material; the correction is recorded rather than smoothed. |
| **SEC-03** | security | **PARTIAL** | M-DEP-SEC-UPG/FINDINGS.md SEC-03; M9.3-security-denial/FINDINGS.md; gates.json E06 FAIL; MAIN-sandbox-path/MEASURED.txt | MEASURED per destination class, each asserted as itself: a loopback HTTP round trip COMPLETES (HTTP_OK) under both confined modes; a private LAN address CONNECTS (192.168.1.1:445); public and private DNS resolve; cloud metadata 169.254.169.254 is ENETUNREACH but that is a property of THIS network, not a sandbox control, and the record says so. The seam carries no network fact at all. | An OS or gateway egress boundary. Also a Linux VM with --unshare-net (WSL2 + bwrap was measured to work as a substrate, but is not wired and is not claimed as a production world). |
| **SEC-04** | security | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md SEC-04; packages/dsh-daily-work/src/sec-gates.test.ts | Every clause measured against a real HTTP server: 22 address classes refused including the unspecified address and an IPv4-mapped IPv6 loopback; DNS rebinding with a mixed answer set refused WHOLE; cross-origin redirect REFUSED and the attacker path never requested; credentialed redirect target refused; non-http(s) refused; the hop cap bounded. LIMIT asserted as well: this is a destination filter on ONE tool, NOT an egress boundary - the loopback row above proves any shell command bypasses it. | Nothing material for this case; the limit belongs to SEC-03. |
| **SEC-05** | security | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md SEC-05; packages/dsh-daily-work/src/sec-gates.test.ts; V7-fs/GATES.md FS-04 | Symlink escape refused with FS_SANDBOX_DENIED at the canonical-target boundary, the outside file byte-identical afterwards; containment compares dev/ino when spellings differ; `checkedTarget` re-canonicalizes NOW and returns the FRESH target, closing the check-here-write-there TOCTOU. Two honest residuals are recorded, not hidden: the fence is "a policy check in TRUSTED code over a MODEL-CONTROLLED path, NOT a kernel boundary", and the residual ancestor-symlink TOCTOU is NARROWED rather than eliminated. A measurement error is recorded too: the first probe put the outside dir under os.tmpdir(), which workspace-write GRANTS, so the write succeeded correctly by policy. | A kernel-level boundary for the residual ancestor-symlink TOCTOU. |
| **SEC-06** | security | **PARTIAL** | M-DEP-SEC-UPG/FINDINGS.md SEC-06; docs/GAPS.md#G-SEAM-21; V6-recovery/import-graph-v6.txt; V6-recovery/tests-T9-A-B.txt; gates.json D10 FAIL; upg-gates.test.ts | The oracle asks that old execution authority FAIL after park/reset. MEASURED FAILURE, in the sharpest form: the guard, its WorkerSettlement type, its RefusalLedger and the run record own `epoch` field were all DELETED rather than wired, because the guard input cannot be constructed on any production path (no production call site writes a terminal task state, and `unknown` has no production exit). `recovery.ts` has NO non-test importer. WITHOUT the guard, offered to the reachable write path WorkService.transition, a stale settlement IS APPLIED. What IS enforced is a live Agent identity by OBJECT comparison, which covers an in-process resume; the cross-PROCESS generation case is NOT covered and is recorded as a NON-CLAIM. The kernel park/reset half is separately unbuilt. | A cross-process settlement producer (deliberately not invented, because inventing one would fabricate the authorization edge) and a kernel park/reset plane. |
| **SEC-07** | security | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md SEC-07; M11-ipython/TRANSPORT-FINDINGS.md; M5-lifecycle/PROBE-FACTS.md fact 16 | The oracle asks for the honest statement, and the honest statement is that a cell id does NOT isolate malicious code. This file asserts the ABSENCE of the claim (no source contains any of four isolation phrasings, and the check is asserted non-vacuous) and asserts what DOES hold: cross-Session and host-privilege refusals, and the object-identity tool-protocol guard. M5 fact 16 measures the positive case directly: an old background thread set shared[value] and a LATER cell printed the mutated value. The transport limit is cited from both records: the default jupyter_client path is PLAINTEXT TCP, and transport=ipc FAILS on Windows. | Nothing material; the case is a claim-about-claims and the measurement supports it. |
| **SEC-08** | security | **BLOCKED_EXTERNAL** | M-DEP-SEC-UPG/FINDINGS.md SEC-08; P3-security/FINDINGS.md SEC-08; docs/GAPS.md; gates.json (old spec NOT_APPLICABLE) | The precondition is TWO OR MORE read-permission domains. This deployment has exactly one execution world (the invoking OS user), and no container/VM/SSH world is mounted. The kernel half HOLDS and is measured (KernelService.entryFor refuses a changed execution world and does not silently replace the kernel). The migration half EXISTS and is correct (changeReadPermissionDomain, kernel-lifecycle.ts:2122, correct order: close admission -> cancel and clean up -> new epoch) but has no production importer, is not exported, and the live ipython plane has no read-permission-domain concept at all. | A second execution world (a container/VM/SSH world) to migrate BETWEEN. A simulated one does not substitute. |

### CAP

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **CAP-01** | integration | **PARTIAL** | V8-capacity/GATES.md CAP-01; cap01-boundary.txt; cap01-n10-real.txt; prod-capacity.json; prod-capacity-report.json; T10-capacity/GATE-TABLE.md | THE N IS 30 AND IT IS NOT 30 REAL CHILDREN. The refusal at the boundary is reached with 29 ARITHMETIC reservations plus ONE real creation call, and the composed-profile boot refuses a real `startContinuable` with "the host already holds 30 children and the hard capacity is 30", highWater 30. The occupancy high-water mark is asserted at every sampled instant ONLY in the synthetic arm; with real children the high-water evidence is at N=1/3/10, not 30. V8 own limitations section says: "A reader must not read 30 real children were refused out of this file." | 30 real children occupying slots simultaneously, then a 31st and 32nd refused. Requires either an authorized provider or a CPU budget the user has excluded. |
| **CAP-02** | integration | **COVERED** | V8-capacity/GATES.md CAP-02; cap02-paths.txt (9 tests); gap-probe.txt (the COLD RESUME arm); capacity-tests.txt; M12-capacity/FINDINGS.md section 2 (all five paths traced to AgentRegistry.create/resume); NOTE: capacity.test.ts drives real in-process children (production AgentLoop, real continuable registry, real in-process spawn provider, a real JSONL Session each) but the MODEL ADAPTER is a controlled local mock - "only the model adapter is controlled, which is the provider boundary and not a second loop" (P5-ready/FINDINGS.md). | Four of the five paths are exercised with real in-process children; the fifth (cold resume) is exercised in gap-probe.txt. The upstream caveat is recorded: `workflow-ptc` startChild still passes NO maxDepth, so it escapes the DEPLOYMENT CEILING even though it no longer escapes the CAPACITY cap (its child still materializes through `agent/created`). Also recorded: an OUT-OF-PROCESS provider (acp, codex, claude-code, dsh-sdk) publishes no local Agent, so it consumes no local slot - out of scope by construction. | A maxDepth fix on the upstream workflow-ptc path. |
| **CAP-03** | integration | **PARTIAL** | V8-capacity/GATES.md CAP-03; cap03-refill.txt; cap01-n10-real.txt; scheduling-tests.txt; P5-ready/FINDINGS.md (rolling: each arm submits once, wakes once, then never calls drain/requestDrain/submitReady again) | The oracle says "recorded against the declared SLO". NO SLO IS FROZEN IN THIS REPOSITORY, so the refill latency is reported as a NUMBER rather than judged against a threshold. V8 states it: "Calling it a PASS against an SLO would require inventing the SLO." The ordering property (immediate refill, no wave barrier) is measured with real children. | A frozen SLO to judge the measured latency against. |
| **CAP-04** | integration | **COVERED** | V8-capacity/GATES.md CAP-04; cap04-cancel.txt; cap04-cancel-live.txt (2 passed); capacity.test.ts (a cancel that has only been REQUESTED still occupies; an assignment waiting on its own tool or provider STILL occupies; the physical slot is released on agent/disposed, not on a record transition); NOTE: capacity.test.ts drives real in-process children (production AgentLoop, real continuable registry, real in-process spawn provider, a real JSONL Session each) but the MODEL ADAPTER is a controlled local mock - "only the model adapter is controlled, which is the provider boundary and not a second loop" (P5-ready/FINDINGS.md). | Nothing material: both arms named by the stimulus are present, including the cleanup-failure arm. | Nothing. |
| **CAP-05** | integration | **PARTIAL** | V8-capacity/GATES.md CAP-05; cap05-root-budget.txt; cap05-root.txt; cap05-root-classifier.txt; scheduling.test.ts C01 (root own settlement-driven turn is not one of the ten children) | THE STIMULUS NAMES 30 CHILDREN CONTINUOUSLY REQUESTING PROVIDER AND TOOL BUDGET. The root-exclusion half is proven by a separate classifier check and by the C01 arm at N=10 (root is not counted). The 30-child arm does not exist: the live arms run at N=1/3/10. | 30 real children sustained while the root also needs to run. |
| **CAP-06** | integration | **PARTIAL** | V8-capacity/GATES.md CAP-06; cap06-no-filler.txt; cap06-no-filler-live.txt; capacity.test.ts (target 30, 2 ready -> exactly 2 real children, capacityDeficit 28, deficitReason insufficient_ready_tasks, outbox >= 2, real registry lists 2); scheduling.test.ts C04 | This is the one capacity case where the N in the oracle IS the N used: target 30 with only 2 ready, and exactly 2 real children are created. But the run is on a controlled local provider route, not 30 authorized provider-backed children, and the "root is notified" clause is asserted through outbox entries rather than a model turn. | An authorized provider to confirm the notification reaches a real root turn. |
| **CAP-07** | integration | **PARTIAL** | V8-capacity/GATES.md CAP-07; cap07-host-wide.txt; capacity.test.ts (two real roots share one host ledger; root B refused at the boundary; gate.occupied stays 3; neither refused child exists in the registry) | THE STIMULUS IS "two roots EACH request 30". The measured arm mounts TWO real roots with the runtime configured for maxActiveSubagents 64 so a refusal can only come from the host-wide ledger - which is a STRONGER instrument for the host-wide claim than the stimulus, but it runs at a small occupancy (gate.occupied 3), not at 30+30. The fairness-queue and real-deficit clauses are not asserted. | Two roots each genuinely requesting 30 children, with the fairness queue and the real deficit visible. |
| **CAP-08** | integration | **PARTIAL** | V8-capacity/GATES.md CAP-08; cap08-target.txt (4 passed); capacity.test.ts CAP-08 (raise 3->5 admits 2 more; a lower stops admissions without killing a working child); target-setting.test.ts CAP-08 (a raise 5->15->5->30 is a live read) | THE STIMULUS IS "30 -> 1 -> 30 while completions arrive concurrently". The measured arms are at small N (3, 5, 15, 30 as SETTINGS values) and the "while completions are arriving concurrently" clause is not exercised at 30. The `revision matches the sequence of changes` clause is covered by target-setting (revision-fenced writes) rather than by this arm. | A 30 -> 1 -> 30 sequence with concurrent completions. |

### UI

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **UI-01** | integration | **PARTIAL** | M12-capacity/FINDINGS.md (the daily-work card entry is NOT registered in packages/client/ui-settings-plugins/src/client/index.ts); target-setting.test.ts UI-01 (a fresh handle over the same stored document reads the persisted value); P7-ui/report.md; P7-ui/client-discovery.json | MEASURED AND STATED BY THE PROJECT ITSELF: "the daily-work card entry is not registered in the UI package. That is a UI-package change outside this milestone file ownership, and it is the one remaining step for UI-01 to be end-to-end in the browser." client-discovery.json: `dsh-daily-work declares dsh.client: false`, `would be a client row: false`. So the stimulus "input 1/10/30 and refresh/disconnect" cannot be performed by a user. The host side (namespace served, revision published, write fenced, change live, persistence across a fresh handle) is implemented and tested. | A registered client card row. Also: the N values exercised are the setting range 1..30, but the refresh/disconnect arm is a fresh-handle read, not a browser refresh. |
| **UI-02** | integration | **COVERED** | M12-capacity/FINDINGS.md (14 illegal values refused at the host: 0, 31, 1000, 2.5, NaN, Infinity, -1, "12", "twelve", null, an object, an array, a boolean, a function; boundaries 1 and 30 accepted); target-setting.test.ts UI-02 (illegal N refused at BOTH boundaries) | The oracle says "UI和host均拒绝". The HOST half is thoroughly measured (14 illegal values, both boundaries). The UI half is vacuous because no UI exists (see UI-01): the second boundary tested is the settings section own validator, not a browser control. The hardcap-immutability clause is covered by CAP-01 (HARD_CHILD_CAPACITY is a module constant). | A UI to refuse at. This is the strongest UI case in the family and it is still one boundary short. |
| **UI-03** | integration | **COVERED** | target-setting.test.ts UI-03 (revision fencing makes a concurrent write an explicit stale rejection); host.ts (SettingsProvider.update(ns, patch, expectedRevision) throws SettingsConflictError) | The stimulus names TWO CLIENTS. The measured arm is two concurrent WRITERS against the revision fence, which is the mechanism the oracle names (one succeeds, the other gets an explicit stale rejection, no silent last-write-wins). The two clients are not real browser clients. | Two real clients. The property itself (explicit stale rejection) is measured. |
| **UI-04** | integration | **COVERED** | target-setting.test.ts UI-04 (the `work` tool exposes NO parameter that could raise target or budget: names asserted equal to [action, childId, goal, taskId]; 12 forbidden names each asserted absent; the action enum has no write-to-settings verb); R4-authorization/report-after.json (a raw model call naming a create action does NOT create a run; a real settings write does not create a run) | Asserted against the REGISTERED tool definition rather than a doc comment, which is the distinction the file itself makes ("a comment cannot refuse a call"). The stimulus says "from IPython/tool" - the tool route is measured; the IPython route is covered by the same registry refusal (the cell has no `ctx` and no settings handle), but not by a dedicated arm. | A dedicated arm driving the attempt from inside a Python cell. |
| **UI-05** | integration | **UNCOVERED** | none | The whole case: no UI exists to display queued/active/provider-wait/stopping/unknown. The STATUS VOCABULARY exists in the host (counting.ts: providerWaiting, active_assignment, stopping, unknown_quarantined, and the file states providerWaiting is "NOT physical concurrency") and the counts are tested, but nothing renders them and nothing asserts a display agrees with real slot/task events. | A UI. The host-side vocabulary and counts are a prerequisite, not this case. |
| **UI-06** | integration | **UNCOVERED** | none | The whole case: no UI exists to display kernel epoch / lost / as-of. The DATA exists and is measured (V3-ipython IPY-14 epoch + LOST + nothing replayed; V6-recovery REC-06 as-of/skipped/lost fields; REC-05 volatileStateLost), but no surface displays it and no case asserts the display is not a false green. | A UI, plus a kernel-state surface. |
| **UI-07** | integration | **UNCOVERED** | none | The whole case: no UI and no Web route to an artifact. The authorized DATA API exists (P13-artifacts: a leaked host path was found and fixed, mutation-tested with 3 mutations; the ledger carries no path), and the artifact plane is measured, but nothing opens an artifact through a Web view, so the oracle clause "does not concatenate a host path or file://" cannot be exercised from a client. | A UI/Web artifact view. The data API it would call is measured. |
| **UI-08** | integration | **PARTIAL** | M8.4-goal-handover/FINDINGS.md (C14: proven against the REAL Goal service - objectivePreserved and revisionUnchanged read back from the service; ANOTHER ROOT IS UNTOUCHED; idempotent; a later resume works and advances the revision); host.ts:866 (takeContinuation is called at createRun, the only moment the exact live root is in hand) | The oracle is "exactly ONE automatic continuer, and the switch is by a PUBLIC handover that is tested". The handover IS tested and the disarm is mild (process-local activation only; the durable objective and revision survive). What is NOT measured is the INVARIANT itself: that with Goal AND managed work both present there is never more than one active continuer at any instant. The test proves the handover works and that another root is untouched; it does not prove mutual exclusion under interleaving. | An interleaving test that asserts at most one active continuer at every observed instant, with both drivers present. |

### VER

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **VER-01** | security | **COVERED** | V9-verification/VER-01-zero-tests-not-a-pass.txt; receipt-ver01-zero-tests.json (exit.code 0, outcome zero_tests, passed false, the reason names the condition); verification-gates-tests.raw.txt (the CONTROL: the same command with the same exit 0 and NO declared counts reports outcome pass, 51/51) | Nothing material: the control arm is what makes the classification the difference. | Nothing. |
| **VER-02** | security | **COVERED** | V9-verification/VER-02-all-skipped-not-a-pass.txt; receipt-ver02-all-skipped.json (exit.code 0, outcome all_skipped, passed false, observedTests {total 2, passed 0, failed 0, skipped 2, todo 0}); verification-gates-tests.raw.txt | Nothing material. | Nothing. |
| **VER-03** | security | **COVERED** | V9-verification/VER-03-candidate-cannot-weaken-its-own-oracle.txt; cli-ver03.txt; receipt-ver03-weakened-refused.json; verification-gates-tests.raw.txt | Nothing material, and the project records a control that FAILED for the right reason and kept it: "the first control arm changed the definition id and was refused for that reason - kept because a control that fails for the reason it is controlling for proves nothing." | Nothing. |
| **VER-04** | security | **PARTIAL** | V9-verification/VER-09-tier-and-limit-stated.txt (the SAME-ACCOUNT measurement taken from inside the verification child: child user hzq00 == host user hzq00 at a different pid, so no privilege separation exists); cli-ver09-account.txt; verification-gates-tests.raw.txt (a candidate child read a host file outside its snapshot verbatim, and a candidate child completed a real TCP connection); v1 acceptance-spec.trusted-local-v1.json not_applicable_inherited entry VER-04 | THE ORACLE CANNOT BE MET UNDER THIS TRUST MODEL, AND THE PROJECT ALREADY SAID SO. 112 VER-04 demands the verification environment be low-privilege with unauthorized operations blocked. MEASURED: the verification child runs as the SAME OS user as the host (hzq00 == hzq00, different pid), a candidate child READ a host file outside its snapshot VERBATIM, and a candidate child completed a REAL TCP CONNECTION. The v1 spec recorded exactly this requirement as NOT_APPLICABLE with the reasoning "the new architecture does not claim that the verification environment is separated from the host. It is not." The 112 spec makes it MANDATORY with no N/A permitted. NOTE THE NUMBERING: v1 VER-04 is a DIFFERENT case (receipt freshness), and v1 says so in its own note. | A real privilege boundary between the verifier and the verified: a separate OS account, container, or VM. Not obtainable from inside the runner. |
| **VER-05** | security | **COVERED** | V9-verification/VER-04-receipt-does-not-outlive-its-tree.txt (fresh -> {fresh:true} check_exit 0; after one byte of a declared input changes -> {fresh:false} with both digests named, check_exit 1 and the runner says re-verify; CONTROL: a FRESH receipt that is not a PASS still exits 1, so freshness is never a verdict); cli-ver04-freshness.txt; receipt-ver04-fresh-pass.json; verification-gates-tests.raw.txt (in-suite arms for the WORKSPACE, ORACLE and ENVIRONMENT bindings independently, each moving exactly one of four real digests, with a restored tree ACCEPTING as the control) | NOTE THE NUMBERING: the evidence files are labelled VER-04 (v1 numbering). v1 VER-04 = this case; 112 VER-05 = this case. Mapped by ORACLE, not by label. | Nothing material. |
| **VER-06** | security | **COVERED** | V9-verification/VER-05-aba-mutation-caught.txt (the frozen arm child read revision A for input+oracle+config while the live tree went A->B->A; liveDigestAtStart == liveDigestAtEnd and liveDriftDetected false, so endpoint polling sees NOTHING; the in-place CONTROL exits 9 having seen the tampered tree, and both receipts carry the SAME start digest); ver05-06-aba-and-inflight.txt; verification-gates-tests.raw.txt | NOTE THE NUMBERING: the evidence is labelled VER-05 (v1 numbering). v1 VER-05 = this case; 112 VER-06 = this case. Mapped by ORACLE. | Nothing material: the oracle demands the control arm be run and it is. |
| **VER-07** | security | **COVERED** | V9-verification/VER-06-in-flight-writers-converged.txt (a live writer lease refuses the freeze; a released lease with a still-moving tree refuses and names BOTH sample digests; a stopped writer converges to a digest EQUAL to the runner own digestInputs; the structural invariant digest!='' implies converged===true holds on every path); ver05-06-aba-and-inflight.txt; verification-gates-tests.raw.txt | NOTE THE NUMBERING: the evidence is labelled VER-06 (v1 numbering). v1 VER-06 = this case; 112 VER-07 = this case. Mapped by ORACLE. | Nothing material. |
| **VER-08** | security | **COVERED** | V9-verification/VER-07-verification-failure-is-recoverable.txt (pause leaves the run paused and refusing run_not_open; a correction child is still admitted WHILE PAUSED; resume re-opens admission; only the later permanent drain rejects with "draining; the operation was not admitted" - which is what proves the paused state was genuinely not-yet-drained); verification-gates-tests.raw.txt (51 passed / 51, TEST_EXIT=0) | NOTE THE NUMBERING: the evidence is labelled VER-07 (v1 numbering). v1 VER-07 = this case; 112 VER-08 = this case. Mapped by ORACLE. | Nothing material. |

### ECO

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **ECO-01** | evaluation | **PARTIAL** | M9-eco/FINDINGS.md ECO-01; packages/dsh-daily-work/src/eco.test.ts; M9-eco/tests.txt (36 passed); M9-eco/sabotage.txt (7 mutations, each shown to make the suite fail, with a restored-source control) | THE TIER IS evaluation AND THE ORACLE IS "each attempt correctly accounted, not overwritten by the last usage". The RETRY MECHANISM is the production @deepseek-ai/dsh-llm-retry executor on the production agent/request-error waterfall, so three attempts are three real requests - but the USAGE NUMBERS are controlled inputs (450/75/1200 vs a last usage of 200/30/500), not an observed provider invoice. The project states this itself: "No provider is authorized, so every number here is a controlled input chosen by a test, not an observation of a real bill." | An authorized provider to observe a real bill for a retried step. |
| **ECO-02** | evaluation | **PARTIAL** | M9-eco/FINDINGS.md ECO-02; eco.test.ts (an attempt whose usage never arrived is known:false and is never priced as zero; the conservative reservation is HELD and the admission is REFUSED on it, with a control proving the refusal is caused by the unknown and not by the ceiling); M9-eco/sabotage.txt | The missing-usage EVENT is constructed by the test rather than produced by a real connection interruption. The record behaviour once the event is reported is measured; the stimulus "连接中断" is not. | A real interrupted connection. |
| **ECO-03** | evaluation | **PARTIAL** | M9-eco/FINDINGS.md ECO-03; eco.test.ts (one total over root+child+retry+compaction+summary+search with all six categories present, the five-term formula each its own number, cache storage included - removing the row measurably lowers the total; cross-provider pricing THROWS; a cache-write field under a protocol with no such line THROWS); M9-eco/sabotage.txt | The oracle is "统一总账无遗漏，provider计价字段不混用". The no-omission and no-field-mixing halves are measured against the real record schema. The "真实总费" (real total cost) half is not: the numbers are controlled inputs, and no provider invoice was observed. | An authorized provider for a real total. |
| **ECO-04** | evaluation | **COVERED** | M9-eco/FINDINGS.md ECO-04; eco.test.ts (across two cells with different budget/kernel-epoch/variable values the RENDERED fixed prefix is byte-identical by sha256, the section order is unchanged, and the dynamic parts sit strictly later in the registry own order; a third cell that changes a variable feeding the prefix MOVES the digest - the positive control) | The file itself refuses the stronger claim: "AN EQUAL PREFIX HASH IS NOT A CACHE HIT. DeepSeek caching is documented as best-effort." The oracle asks for prefix stability, which is exactly what is measured. | Nothing material for this case. |
| **ECO-05** | evaluation | **PARTIAL** | M9-eco/FINDINGS.md ECO-05; eco.test.ts (prompt tokens fall 20,000 -> 12,000, -40%, while the priced bill RISES; reportCostDelta reports both and sets cheaper:false; a control where the bill really falls sets cheaper:true) | The oracle is "report the real bill may be more expensive". The REPORTING behaviour is measured and the control proves the flag is not stuck - but the price movement is a constructed input, not an observed bill. Also recorded honestly: the file says this premise "is asserted as an assumption" about provider pricing. | An authorized provider, and a documented price book, to observe a real token-down/bill-up case. |
| **ECO-06** | evaluation | **COVERED** | M9-eco/FINDINGS.md ECO-06; eco.test.ts (with the shadow enabled the request count read from inside the real LlmAdapter.stream and the effect count read from inside the real tool execute are UNCHANGED at 2 and 1; shadow.sideEffects().total === 0; agent.session.seq unchanged) | Nothing material: the counts come from the real adapter and the real registry, not the shadow own bookkeeping. | Nothing. |
| **ECO-07** | evaluation | **BLOCKED_EXTERNAL** | M9-eco/FINDINGS.md ECO-07; eco.test.ts (the stock arm is verified UNMODIFIED: its patch file active content is the literal [], its bundles are exactly the two shipped ones, and the composed stock graph re-derives to the digest M0.5 recorded b64151b3...; the daily-candidate patch hashes to 2a0aff17...); compatibility.lock.json | The STIMULUS IS "compare stock with IPython/data-plane". The controlled-variable half (fixed version/model/task/budget/permission, stock not secretly modified) is measured. THE COMPARISON ITSELF is BLOCKED_EXTERNAL: live_provider_budget_authorized is false, so no stock-vs-candidate paired run exists. | An authorized live provider budget for the paired comparison. |
| **ECO-08** | evaluation | **BLOCKED_EXTERNAL** | M9-eco/FINDINGS.md ECO-08; eco.test.ts (Wilson intervals that do NOT collapse to certainty at n=6 - 6/6 gives lower bound 0.610, not 1; sample variance undefined at n=1 rather than 0; three axes reported separately with overlapping intervals so NO WINNER IS DECLARED); compatibility.lock.json | The STIMULUS IS "representative coding+research tasks run paired many times". The ESTIMATOR and its honest behaviour are measured. THE PAIRED RUNS THEMSELVES are BLOCKED_EXTERNAL: no authorized budget, so no success/failure/variance/confidence-interval figures exist for real tasks. | An authorized live provider budget for repeated paired runs. |

### RES

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **RES-01** | fault_injection | **PARTIAL** | M5-lifecycle/PROBE-FACTS.md facts 4 and 6; M5-lifecycle/lifecycle-probe2.json (cancel_under_flood: interrupt delivered in 0.002 s, cell settled 7.325 s after the cancel was issued, totalBytes 576,323,584, emittedBytes 4096, truncated true) | A REAL flood with a REAL cancel was measured, and the oracle "control is not starved by the data queue, measure the latency" is answered with BOTH numbers (dispatch 0.002 s, settle 7.33 s). But PROBE-FACTS states plainly: "Any behaviour of the DSH host, the DSH broker, or a DSH Session. No DSH process participated." The measurement is of a real ipykernel through a probe broker, not through the product own broker. Also, the stimulus says "大量page流" (a large PAGE stream, i.e. the native data plane) - the flood measured is a stdout stream, a different queue. | A control-latency measurement through the DSH broker and the native data-plane queue, not stdout. |
| **RES-02** | fault_injection | **COVERED** | V3-ipython/run-faults.txt req 10 (a cell printing ~200 MB with a 64 KiB cap returns ok with truncated:true, totalBytes > 200 MB, retained text bounded, a spill file written and its size asserted > 0; a control asserts an under-cap cell reports truncated:false; a third asserts a 4 MB display_data payload is bounded by its own cap); M11-ipython/FINDINGS.md req 10; M5-lifecycle/PROBE-FACTS.md facts 4 and 5 (broker RSS 70.41 -> 70.84 MB while 256 MiB was produced); protocol.test.ts (MAX_FRAME_BYTES checked against the DECLARED length before the bytes are buffered, proven with a header claiming more than the limit and no payload) | The M5 probe (which measured the RSS bound) did not involve a DSH process, but the V3 arm does: it runs through KernelService with a real broker and a real ipykernel, and the bound is asserted with a control. | Nothing material. |
| **RES-03** | fault_injection | **PARTIAL** | V3-ipython/GATES.md section 2; run-v3-spec-gates.txt; M5-lifecycle/PROBE-FACTS.md facts 1, 2 and 16; kernel-recovery.test.ts (classifies output arriving after a cell settled as `late` for the ORIGINATING cell; classifies a frame whose parent was never issued as `unattributed`; classifies a stray shell reply as `foreign`) | Clause 1 (a background thread or C extension writing after the cell returns is classified late/unattributed and not attributed to a new cell) HOLDS and is measured at both tiers. Clause 2 FAILS: a write landing DURING a later cell is ATTRIBUTED to that later cell rather than reported undecidable - the same measured defect as IPY-13 clause 2, filed under two ids because the two spec cases share the stimulus. | A second IOPub channel or a process boundary, which the audit forbids - an architecture change. |
| **RES-04** | fault_injection | **PARTIAL** | M5-lifecycle/PROBE-FACTS.md facts 8 and 9 (an await-suspended cell does NOT settle - timedOut after 25.16 s, interrupt delivered, second interrupt also delivered, alive true; a C-extension cell also does NOT settle - re.match on (a+)+ timedOut after 12.16 s); V3-ipython/run-faults.txt; kernel-recovery.test.ts (escalates to process isolation on a non-interruptible C extension, and says so) | The oracle is "timeout escalates to process-isolation cleanup; do not claim all are recoverable". Both non-settling classes ARE measured, and the escalation is implemented and unit-tested with an honest `escalated` action. BUT the implementation lives in kernel-lifecycle.ts, which the import graph shows has NO non-test importer, so the ESCALATION is a mechanism rather than a product behaviour. The live plane does implement interruptGraceMs -> unknown -> restart (IPY-07), which is the reachable half. | A production importer for kernel-lifecycle.ts. Also: the oracle says "不可及时中断工作" generally, and M5 records that two classes are evidence of EXISTENCE, not a classification of all C code. |
| **RES-05** | fault_injection | **UNCOVERED** | M12-capacity/FINDINGS.md (RES-05: 31 kernels RSS is NOT_RUN - "This is the resource measurement the plan asks for at M6.10; it needs 30 real children, so it is blocked by the same external budget as #1"); M11-ipython/FINDINGS.md (Resource budgets RES-04/05/06: RSS, pids, parked kernels. Not addressed) | The whole case. The STIMULUS IS "30 children really start a kernel and hold large objects" and the ORACLE is that RSS/CPU/pids are counted against a budget and a shortage is explicitly blocked. NOTHING exercises this: no 30-child run exists, and the RSS/pids budget mechanism lives in kernel-lifecycle.ts (unreachable from production). M5 fact 13 measures a SINGLE parked kernel (79.50 -> 357.71 MB holding one 256 MiB array) and M5 fact 14 records that np.zeros under-reports - those are single-kernel facts, not a 30-kernel budget. | 30 real children each holding a kernel with large objects. Requires the CPU budget the user has excluded, or an authorized provider. |
| **RES-06** | fault_injection | **UNCOVERED** | M12-capacity/FINDINGS.md (parked kernels named as not addressed); M11-ipython/FINDINGS.md (RES-04/05/06 not addressed); kernel-lifecycle.ts (parkedRssBytes budget 2 GiB, a parked kernel counted against it, eviction in a reclamation pass) | The whole case: no case exercises many historical children leaving parked kernels. The MECHANISM exists in kernel-lifecycle.ts (parkedRssBytes, eviction) but that module has NO non-test importer (verified in this inventory with qualification/runners/import-graph.mjs), so no product behaviour can evict anything. M5 fact 13 supplies the single-kernel RSS fact the mechanism is built on, which is a prerequisite rather than the case. | A production importer for kernel-lifecycle.ts, and a run with many parked kernels. |
| **RES-07** | fault_injection | **PARTIAL** | packages/dsh-ipython/src/bridge.ts (each lease owns a FIFO exact-tool-call queue; the queue is bounded by MAX_FRAME_BYTES at the framing layer; `pending` is deliberately NOT inFlight.size + queue.length); r5-product-bridge.test.ts (concurrent Python submission SERIALIZES: at most one exact call is ever in the registry); native-call.ts (the order must be the order the bridge ACCEPTED the calls) | The stimulus is "the native return rate is higher than the kernel consumption rate" and the oracle is "BOUNDED queues/credits; the server does not put all pages in memory". The bridge serializes and the framing is bounded per frame, and R5 proves at most one exact call is in the registry at a time - but there is NO credit mechanism and NO measurement of what happens when a cell submits faster than the host can serve. The queue is a JS array with no length cap. | A rate-mismatch arm: a cell submitting far faster than the host serves, with a measured queue bound or a credit refusal. The unbounded `queue: AcceptedCall[]` is the specific gap. |
| **RES-08** | fault_injection | **PARTIAL** | r5-product-bridge.test.ts (concurrent Python submission SERIALIZES per lease); bridge.ts (each lease owns its own FIFO queue); M9.13-isolation/FINDINGS.md (a queued follow-up WAKES an idle root) | The stimulus is "one cell calls at high frequency while another interacts in parallel" and the oracle is "per-Session AND global fairness plus a budget limit; the root can still be served". Serialization is per LEASE, which is the mechanism a fairness policy would sit on - but no arm runs two sessions against one bridge with one flooding, and there is no global fairness queue and no per-cell call budget on the bridge route (the per-cell nested-call budget exists in kernel-lifecycle.ts, which is unreachable). | A two-session arm with one flooding, plus a global fairness/budget mechanism on the reachable bridge route. |

### UPG

| id | tier | class | artifact(s) | unaddressed clause | missing thing |
|---|---|---|---|---|---|
| **UPG-01** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md UPG-01; packages/dsh-daily-work/src/upg-gates.test.ts (lib/ exists, every declared export points at a ./lib/*.js + .d.ts pair that EXISTS, EVERY production source has a compiled counterpart, the modules are then IMPORTED at runtime; the profile depends by link: and declares the bundle in dsh.profile.bundles; no absolute source path or file:// in either patch); M9.17-b02-resolver/FINDINGS.md | The oracle says "第一次python/native调用成功". The BUILD half and the INSTALL half are measured, and the first-call half is cited from M8.5/R9 (27 tools including `work` on a fresh install). The reach limit is recorded rather than implied: the dependency is a `link:` to this checkout, so this is a DEVELOPMENT install, not a published one. | A real published package (npm registry) rather than a link: install. |
| **UPG-02** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md UPG-02; packages/dsh-daily-work/src/upg-gates.test.ts (a stored version NEWER than this build writes -> readHeader returns `unsupported` naming storedVersion, targetVersion and the direction; an unknown event type with no ignorable marker DECODES then finish() FAILS with SessionFormatUnsupportedMigrationError naming the type and seq; the SAME event with ignorable:true is RETAINED and the count includes it) | Nothing material, and the decode-then-fail trap is explicitly called out: a consumer that stopped after decodeRow would read the log as intact. | Nothing. |
| **UPG-03** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md UPG-03; packages/dsh-daily-work/src/upg-gates.test.ts (an OLD and a NEW locator coexist and both stay readable; the old file digest is unchanged after further writes; the sweep is exact-shape ^session-[0-9a-f]{12}$ and never touches a foreign directory - OBSERVED by planting every near-miss name (11/13 hex, uppercase, non-hex, bare prefix, session-backup, session-<12hex>-extra) plus a session-shaped JUNCTION to a foreign tree, all surviving byte-identical while an in-shape expired file is reclaimed; permissions declared 0700/0600) | Nothing material: the "wrongly re-owned" hazard is closed by a shape rule and the near-misses are planted rather than assumed. | Nothing. |
| **UPG-04** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md UPG-04; packages/dsh-daily-work/src/upg-gates.test.ts (a store is seeded, hashed, copied to a DIFFERENT directory, and reopened by a fresh host over the copy: the trees are byte-identical, the run reopens with the same runId, rootSessionId, authorizationRef, epoch (1 - a restore is not a new generation) and requestedTarget; the SOURCE is unchanged, so a backup is not destructive; kernel volatile state is excluded STRUCTURALLY by a check on the store FIELD NAMES) | The oracle says "在新host恢复" (restore on a NEW host). The measured arm reopens the copy in a fresh host CONTEXT in the same process and on the same machine, not on a second physical host. | A second physical host. The same-account limitation means a second host on this machine would not be a different trust domain anyway. |
| **UPG-05** | integration | **COVERED** | M-DEP-SEC-UPG/FINDINGS.md UPG-05; packages/dsh-daily-work/src/upg-gates.test.ts (a newer unit version makes the open fail with StorageError/version-mismatch and the file bytes are byte-identical afterwards, with the control that restoring the original bytes makes the store open normally; a REAL two-version rollback: v1 writes, v2 migrates via per-record compatibleVersions, v1 reads an EMPTY table because v2-stamped records are discarded); M9.20-real-tasks/u06-rollback.mjs (old artifact + old consistency snapshot restored byte-for-byte; the external effect reconciled with the REAL effect ledger and the remote reached ZERO times through perform; "after the rollback, the remote counter still reads 1. The software went back; the send did not.") | The rehearsal names its own fixtures: the "new version" is a version-bumped copy of the SAME code because no newer release exists, and the remote is a COUNTING FAKE because no real remote is authorized. Both are recorded in the evidence, not glossed. | A real newer release and a real remote. The property (a rewind does not withdraw an external effect) is measured on a counting fake. |
| **UPG-06** | integration | **PARTIAL** | M-DEP-SEC-UPG/FINDINGS.md UPG-06; packages/dsh-daily-work/src/upg-gates.test.ts (a spill artifact written by a session that is STILL LIVE and STILL REFERENCES IT, aged past the cutoff, is GONE after sweepSpillRoots; SweepOptions carries cutoffMs and warn and NO reference, lease or live-session input, so the sweep CANNOT respect a live reference - this is not a misconfiguration; the content-addressed store DOES survive, but that is the WEAKER of the two ways to hold the property: it holds because the store has NO COLLECTOR AT ALL, not because a collector respects references) | The property the oracle names DOES NOT HOLD for spill artifacts, and the test proves it by deleting one. The reference-aware collector exists (referenced and pinned objects survive an age past any grace window; an orphan is collected with a tombstone) but has NO production caller. The durable half that DOES exist is the run record carrying lastReconciledRefs, which is a prerequisite, not the gate. | A reference-aware sweep: SweepOptions must accept a reference/live-session input, and the collector must have a production caller. |
| **UPG-07** | integration | **BLOCKED_EXTERNAL** | M-DEP-SEC-UPG/FINDINGS.md UPG-07; M-DEP-SEC-UPG/UPG-08-verdict.txt; packages/dsh-daily-work/src/upg-gates.test.ts (no provider-driving API is called anywhere in the file - asserted by scanning the file own code with comments and string literals stripped); compatibility.lock.json (runtime_authorization.live_provider_budget_authorized: false) | The whole case: an AUTHORIZED frontier provider driving 30 non-empty children. The gate own text forbids a substitute ("mock结果不替代本门"), and the mock-based N=10 result is asserted to be a DIFFERENT fact rather than a stand-in. Nothing in the repository manufactures a result for this gate. This is the case the user most needs to see: it cannot be closed by any work inside this repository. | An authorized live provider budget. The user has none, so this must never be faked. |
| **UPG-08** | integration | **COVERED** | M-DEP-SEC-UPG/UPG-08-verdict.txt (verdict NOT_READY, DERIVED from the per-gate table in upg-gates.test.ts and written by the test itself so it cannot disagree with the rows; 8 of 24 are not PASS; the blocking set with reproduction and external blocker per row); packages/dsh-daily-work/src/upg-gates.test.ts (the verdict is NOT_READY and is computed from the table rather than typed; every blocking row must carry a reason >20 chars; every row must carry an evidence path that exists) | Nothing material. The oracle is "any mandatory FAIL/NOT_RUN/BLOCKED -> NOT_READY with the concrete reproduction and the external blocker" and this is exactly what the file computes. NOTE the scope: it covers the 24 DEP/SEC/UPG gates it tabulates, not all 112 cases - so it is a correct UPG-08 verdict for its own table, and the wider NOT_READY follows a fortiori from this inventory. | Nothing. |

---

## 3. What this means for readiness

### The promotion decision does not move

**NOT_READY.** Four reasons, in order of how little they can be argued with:

1. **The authority spec says so.** All 112 cases are `NOT_RUN` with empty `evidence`;
   `AUDIT_STATUS.json` records `production_qualification: "NOT_READY"`. This inventory does not
   edit that file, and could not honestly do so.
2. **Six cases are BLOCKED_EXTERNAL and cannot be closed from inside this repository.** Four need
   a live provider budget the user does not have (`IPY-08`, `ECO-07`, `ECO-08`, `UPG-07`); two need
   a second execution world that does not exist here (`DEP-04`, `SEC-08`). The spec's own UPG-08
   rule is that any mandatory BLOCKED_EXTERNAL forces NOT_READY, and `UPG-07` alone is sufficient.
3. **Two cases are honest, measured FAILs of a property the architecture does not provide.**
   `SEC-01` (host-secret read) and `SEC-03` (egress) were re-measured and the platform does not
   deny: a confined child reads outside its workspace and completes a real HTTP round trip. The
   sandbox seam has no read lever and no network lever *in its type*, so this is not a bug to fix
   but a boundary that does not exist. The audit's own remedy is a dedicated Linux VM.
4. **The largest structural gap is a UI that was never built, plus a reachability class that keeps
   recurring.** Three `UI` cases are UNCOVERED outright (`UI-05`, `UI-06`, `UI-07`), and two more
   are PARTIAL for the same reason: `dsh-daily-work` declares no `dsh.client`, so no browser card
   exists. Separately, `kernel-lifecycle.ts`, `perf-metrics.ts`, `ui-card.ts`, `effects.ts` and
   `recovery.ts` all have **no non-test importer** - verified in this inventory by running
   `qualification/runners/import-graph.mjs`, which reports 8 unreachable modules of 41 in
   `dsh-daily-work` and 15 of 26 in `dsh-ipython`. Every `REC-06`/`REC-07`/`REC-08` and `RES-04`
   verdict that rests on `kernel-lifecycle.ts` is therefore a statement about a MECHANISM.

### What is genuinely demonstrated vs merely implemented

**The short answer: about two thirds is demonstrated, one quarter is demonstrated in part, and
roughly one in twenty cases has nothing at all.**

| | cases | share | what a reader may rely on |
|---|---|---|---|
| **Demonstrated** | **76** | **67.9%** | An artifact exercises the stimulus and checks the oracle. A reader may cite the named artifact. |
| **Partly demonstrated** | **25** | **22.3%** | Part of the oracle holds; the named clause does not. Citing the case as satisfied would overstate it. |
| **Nothing at all** | **5** | **4.5%** | No artifact exercises the stimulus. |
| **Blocked externally** | **6** | **5.4%** | Cannot be closed here. Not a failure of the work; a missing world or budget. |

**But the 76 needs three qualifications, and they matter more than the headline number.**

**(a) A large part of the 76 is demonstrated at a tier BELOW what its label implies.** The
`integration` tier asks for *"a real assembled product"*. Many of the strongest results here are
measured through the production services with a **controlled model adapter** standing in for the
provider - real `AgentLoop`, real continuable registry, real in-process spawn provider, a real
JSONL Session each, and only the model boundary scripted. That is the correct and honest tier for
a mechanical admission/refill oracle, and the evidence files say so. But it is not the same claim
as "a real user action drove this on the shipped profile", and the difference is exactly where
this project has been bitten before: `G-SEAM-31` records that nothing in the product created a run,
so the N=10 result came from tests that called `createRun` directly. `R4-authorization` later
closed that by mounting `/work start` through the human command registry and measuring a real
composed-profile boot - which is why `UPG-08` and the capacity cases can be read as product-path
results at all.

**(b) "COVERED" here means "an artifact establishes this oracle", not "the product is qualified".**
A catalog measurement proves a row is wired; it does not prove the behaviour behind the row. The
project says this itself in `docs/DELIVERY.md` §8.2: *"a tool appearing in a catalog is not a spec
PASS." The 27-tool fresh-install surface is real evidence, and it is evidence about composition.

**(c) The distinction the brief asked about is visible in specific rows.** Cases where the
mechanism is correct and unit-tested but the product does not reach it are marked PARTIAL with the
reachability stated: `REC-06`, `REC-07`, `REC-08` (all three carried by `kernel-lifecycle.ts`),
`RES-04` (the C-extension escalation lives in the same module), `RES-06` (the parked-memory budget,
same module), `RES-07`/`RES-08` (no credit mechanism and no global fairness on the reachable bridge
route). A reader who counted these as COVERED would be counting implementation as demonstration -
which is the exact error this project has recorded twelve times.

### The single most misleading thing a reader could take from the existing evidence

`qualification/gates.json` shows **84 PASS out of 104**, and `qualification/results/MAIN-112-status/STATUS.md`
records that **92 of the 112 cases are "named" by some evidence file**. Neither is a statement about
the 112. The two id spaces are disjoint (`A01`..`J03` versus `DEP-01`..`UPG-08`), so an id-keyed
migration finds no collision and could count 104 old PASSes as evidence for 112 new cases. And
"named by a file" is a mechanical string match: a case named only inside a *what is NOT proven* list
is counted by that search. This inventory is the corrected reading: **76 COVERED, not 92 named.**

---

## 4. Highest-value next measurements, ordered by value

Each entry names what to run, what it would settle, and why it ranks where it does. The ordering
is by *how many cases a single measurement moves* and *whether it is achievable on this machine
without a budget the user does not have*.

### 1. Run the import-graph reachability scan as a STANDING GATE over both packages

**Command:** `node qualification/runners/import-graph.mjs packages/dsh-daily-work` (and `packages/dsh-ipython`).
**Settles:** which cases may be cited as product behaviour at all.
**Why first:** it is cheap, it needs no budget, and it is the single instrument that separates
demonstration from implementation in this repository. Run today it reports **8 unreachable modules
of 41** in `dsh-daily-work` (`kernel-lifecycle`, `perf-metrics`, `ui-card`, `effects`, `recovery`,
`reconcile`, `durability-runner`, a probe) and **15 of 26** in `dsh-ipython` (mostly probes, plus
`doctor-cli`). Every one of those is a case whose evidence currently reads as a PASS in some gate
table. Making the scan a gate means the next mechanism that gets built and not wired fails loudly
instead of being discovered later - which is what happened twelve times already.

### 2. Reach 30 REAL children once, and re-run CAP-01/CAP-05/CAP-07/CAP-08 at N=30

**What:** 30 real in-process children occupying slots simultaneously (a scripted adapter is
acceptable for the MECHANICAL oracle; it is not acceptable for UPG-07, which the spec forbids
substituting for), then the 31st/32nd refusal, a 30->1->30 target sequence with concurrent
completions, and two roots each requesting 30.
**Settles:** `CAP-01`, `CAP-05`, `CAP-07`, `CAP-08` move from PARTIAL to COVERED; `CAP-06` gains
its real-children arm.
**Why second:** five cases turn on one run, and the oracle explicitly names the number. The
current evidence reaches the boundary with 29 *arithmetic* reservations plus one real call - a
legitimate instrument for the boundary, but not the scenario the oracle describes. **CPU note:**
this is the run the user excluded on CPU grounds, so it should be scheduled deliberately, not
assumed. It does not need a paid provider.

### 3. Register the `daily-work` client card, then re-run UI-01/UI-02 and open UI-05/UI-06/UI-07

**What:** the one-line change M12 already identified - register the card entry in
`packages/client/ui-settings-plugins/src/client/index.ts` binding the `daily-work` namespace - plus
the three surfaces that do not exist at all: the status display (queued/active/provider-wait/
stopping/unknown), the kernel-state display (epoch, lost, as-of), and an authorized artifact view.
**Settles:** `UI-01` and `UI-02` become fully covered (both are host-complete today); `UI-05`,
`UI-06`, `UI-07` are the three UNCOVERED cases in the largest single block of this inventory.
**Why third:** the host half is already built and tested for `UI-01`/`UI-02`, so the marginal work
is small relative to four cases - and `UI-05` in particular guards against a failure mode the
project cares about (*"不全标running"*: do not label everything running). Note that `UI-05` needs the
status vocabulary that `counting.ts` already carries (`providerWaiting` is already documented as
*"NOT physical concurrency"*), so the data exists and only the surface does not.

### 4. Decide and record the SEC-01/SEC-03 remedy as an architecture decision, or provision the VM

**What:** either provision the Linux execution world the audit names as the production path
(`MAIN-sandbox-path` measured that WSL2 + `bwrap --unshare-net` actually works as a substrate), or
record the decision that this deployment will not claim read or egress confinement and adjust the
cases to `NOT_APPLICABLE` the way the v1 spec already did.
**Settles:** whether `SEC-01` and `SEC-03` are FAILs to close or non-claims to state.
**Why fourth:** these two are honest measured FAILs and the project has already done the analysis
twice (`P3-security`, `M9.3-security-denial`). They do not block any other case. But the v1 spec
records that it resolved the SAME requirements as `NOT_APPLICABLE` on the grounds that the
architecture does not claim them - and the 112 spec makes them mandatory. That discrepancy between
the two specs is itself a decision someone should take deliberately rather than inherit.

### 5. Add a rate-mismatch arm to the bridge: RES-07 and RES-08

**What:** one cell submitting native calls far faster than the host serves them, and two sessions
against one bridge with one flooding, with the queue depth measured or a credit refusal asserted.
**Settles:** `RES-07` and `RES-08`, both PARTIAL today.
**Why fifth:** the bridge serializes per lease and frames are bounded, so the mechanism a bound
would sit on exists - but `bridge.ts`'s `queue: AcceptedCall[]` is a plain JS array with no length
cap, and the per-cell nested-call budget that would bound it lives in the unreachable
`kernel-lifecycle.ts`. This is the one fault_injection gap that is a *code* gap rather than a
missing world, so it is closable here.

### Also worth doing, below the top five

- **`VER-04` needs a decision, not a measurement.** The 112 spec makes verification-environment
  privilege separation mandatory; `V9-verification` MEASURED that the child runs as the same OS
  user as the host (`hzq00 == hzq00`), a candidate child read a host file verbatim, and a candidate
  child completed a real TCP connection. The v1 spec recorded this exact requirement as
  `NOT_APPLICABLE` with the reasoning that the architecture does not claim it. Under the 112 spec
  it can only be a FAIL until a real privilege boundary exists.
- **`UPG-06` needs a reference input, not a run.** `SweepOptions` carries `cutoffMs` and `warn` and
  no reference/lease/live-session input, so the sweep cannot respect a live reference. The test
  proves this by deleting a still-referenced artifact. The reference-aware collector exists with no
  production caller. This is a small, well-scoped code change.
- **`DAT-02` needs a mounted `data.*` tool row** so a cell can drive the page walk itself, rather
  than the host driving it on the cell's behalf (`cellReachedDataPlane false` today).
- **A T2 host with >=100 pages of history** would move `HIS-04`'s 100-page traversal from T1 to T2.

---

## 5. What this inventory does NOT claim

- **It does not claim any case PASSes.** It classifies EVIDENCE. The authority spec remains all
  `NOT_RUN`; nothing was edited; the promotion decision remains NOT_READY.
- **It does not re-measure anything.** No test suite was run, per the CPU constraint. Every class
  rests on reading the artifact named in its row. Where an artifact labels its own claim
  `[read in source]` rather than `[measured]`, that label is carried into this file rather than
  upgraded.
- **It does not claim the 76 COVERED cases are equally strong.** They are not. A row whose
  artifact is a real boot on the composed profile (`BRG-01`, `HIS-01`, `IPY-09`, `SEC-02`) rests on
  different evidence from a row whose artifact is a T1 test with a controlled adapter (`DAT-01`..
  `DAT-08`, most `ECO`). The artifact column is where that difference lives, and the tier column
  says which strength the oracle demands.
- **It does not map the v1 109-case spec onto the 112 by position.** The two overlap heavily in
  subject but the numbering diverges: v1 `VER-04` is *receipt freshness* while 112 `VER-04` is
  *verification-host bypass*, and from that point the whole VER family is shifted by one. The
  mapping in this file is by ORACLE, and every shifted row says so. The `IPY` and `CAP` families
  align cleanly; the `DEP` family maps onto v1's `ID` family with `DEP-07`/`DEP-08` having no v1
  counterpart at all.
- **It does not treat "named by an evidence file" as evidence.** `MAIN-112-status/STATUS.md`
  recorded 92 cases named mechanically; that search finds a case id wherever it appears, including
  inside a *what is NOT proven* list. This inventory reads the assertion, which is why the number
  is 76.
