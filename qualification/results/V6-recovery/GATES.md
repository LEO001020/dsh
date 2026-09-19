# V6-recovery — the RECOVERY family (REC-01 … REC-10) at deployment identity `0a0996f3`

**Spec:** `qualification/specs/acceptance-spec.trusted-local-v1.json`, family `RECOVERY`, 10 cases.
**Repo:** `D:\DSH\work\dsh-native-daily` @ branch `ipython-native`, HEAD `c3b9dba` when the
measurements were taken (a sibling committed `07043f0` while this slice was running; no file
this slice measures was touched by that commit — see §0).
**Pinned DSH (read-only):** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`.
**Deployment identity:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`.

Every claim below is labelled `[measured]` or `[read in source]`.

---

## 0. The build these cases ran against

`[measured]` `tsc -p tsconfig.json` → **exit 0**, and the rebuild was byte-identical to what was
already in `lib/`, so the linked build was current rather than stale. Digests in
`source-digests.txt` (this file's own sha256 is `b59ca5fc…`).

| file | sha256 |
|---|---|
| `src/recovery.ts` | `5edde8a5d8d79b0a138f06818a9deb3a04ccc6c22dd7bfe1ae338c967a45f440` |
| `src/reconcile.ts` | `bc5cd7f06a437a07f82682241023b0b50f10043df6928d0ebde2ed92dbc85b70` |
| `src/effects.ts` | `e8945b46ce3691ee91c0103693b201326895a091de41b110ab57abd207997d58` |
| `src/record.ts` | `96026da6bd546b10489515cabfb12fc5928467b51e76d765dcf2cfa9232bd39e` |
| `src/host.ts` | `17c78677a23fe809e7f8613785e97c375b473965874a10fd561a381d8de40bd6` |
| `src/kernel-lifecycle.ts` | `b2a90624601afb906a046fe82b97a7ddc3f6f1489c56d9e511d4e4d15bca3cbd` |
| `lib/host.js` (what homes link to) | `385e792444a5c34f22c6375a570c271e7973ddd3ddb89e13359dcec2205c7de9` |
| `lib/recovery.js` | `c8b6e996a8ec99dc2f4fd76762b67e9ac91071fd29cc67598f19543e5f14199d` |
| `src/durability-advanced.test.ts` | `79275f4deb13e2a5979f33e32938cf48ce0b9c2a185913c3c65f1c253f06e24f` |
| `src/durability-records.test.ts` | `47ab17ab46a5b5e1f77db5b6377a4f63e61275ee657d0ad2f92205a383a89b6a` |
| `src/data-plane.test.ts` | `a43d06d60eeacd388c2651d70473f7b22d06f80ba00a53047329d5940b6b9e8e` |
| `src/kernel-recovery.test.ts` | `03797887c64150e0794478ee955adb5670a93b1ef1a7c947992aa5b85f366547` |

`[measured]` **The spec file changed under this run, twice, and the final state is recorded
rather than smoothed over.** At the start the pinned `trusted_local_acceptance_spec_sha256`
matched disk (`e5b6a1d2…`). Then a sibling slice (V5-data) filed its twelve DATA cases and
committed at 07:51:08, moving the file to `dbe6ac01…`; this slice then filed REC-01..REC-10,
moving it again to **`600d75bd…`**. `verify-identity.py` reports the digest check FAILED as a
consequence, and the identity literal `0a0996f3…` still recomputes from the lock's inputs
(`[measured]`, MATCH) because the pin is a literal that no filing updates. **Every measurement
below remains valid at `0a0996f3…`**: none is a function of the spec file's bytes, and every file
this slice measured has its digest recorded in §0. See §11.

`[measured]` The filing was done as **text surgery, not a `json.dumps` round-trip**, and the
reason is worth recording: V5-data committed its evidence with a non-standard indentation style
(12 spaces for an evidence object, 18 for its keys). A round-trip through `json.load` +
`json.dumps(indent=2)` normalises that style and rewrites ~280 lines the sibling owns — measured,
the naive version produced a **749-line diff** for a change that is semantically 10 cases. The
final diff is **224 lines and touches only the RECOVERY family**, verified field by field:
`non-REC cases that differ: NONE`, all 109 ids equal, top-level non-`cases` keys equal, and the
twelve DATA filings byte-identical. `qualification/results/V6-recovery/file-rec-cases.py` is the
script, and it asserts each of those properties rather than trusting the write.

---

## 1. Gate table

| Case | Assertion | Exact command | Measured result | Verdict |
|---|---|---|---|---|
| **REC-01** | an object published before its reference commits is an orphan, not a delivery | `vitest run src/data-plane.test.ts -t "crash consistency"` | real SIGKILL between `put` and `log.commit`: `[crash] signal null exitCode 1 orphans 1 integrityErrors 0 objectVerified true`; `resolveReference` rejects `artifact-orphaned`; grace GC keeps it, later GC collects it | **PASS** |
| **REC-02** | a bad reference is an integrity failure | `vitest run src/data-plane.test.ts -t "DAT-08"` and `-t "a corrupt or truncated artifact"` | missing object → `artifact-integrity-error` (never `''`); replaced-at-same-length → `artifact-integrity-error`, message matches `/hashes to/`; truncated → same; intact control still served | **PASS** |
| **REC-03** | a crash before admission publishes nothing | `node qualification/runners/v6-rec03-crash-before-admission.mjs` (this slice) | window arm: SIGKILL after `createRun`, before `admit` → reopened store `taskKeys: []`, `reserved: 0`, run still exists. **Control arm** (same program WITH `admit`, killed at the same point): `taskKeys: ["t1"]`, `reserved: 7` | **PASS** |
| **REC-04** | a lost effect reply stays unknown | `vitest run src/durability-advanced.test.ts -t "T9-B"` + `src/durability-records.test.ts -t "D07"` + `src/effects.test.ts` | remote commits then the call throws: `performed=true`, `outcome=unknown`; second `perform` reconciles by QUERY, `outcome=confirmed`, **1 transport invocation across 2× perform + 1× reconcile**; unqueryable adapter → `performed=false`, `outcome=unknown`; real-kill D07 → every fault-shaped reading resolves `unknown` with the slot held | **PASS** |
| **REC-05** | kernel death advances the epoch and names the loss | `vitest run src/faults.test.ts -t "requirement 11"` | real `taskkill /F` on the kernel pid: new epoch, `volatileStateLost: true`, `previousEpoch` = the old one, a reason string, and the replacement kernel is usable and empty | **PASS** |
| **REC-06** | a checkpoint behind the last cell reports what was skipped | `vitest run src/kernel-recovery.test.ts -t "recovery reports state honestly"` | `checkpointAsOf` reported even when nothing was restored; `restored`/`lost`/`skipped` each their own field; an environment change sets `environmentChanged: true`; `RECOVERY_SCOPE_STATEMENT` says "not full session recovery" and "No past cell was replayed" | **PASS (mechanism)** — see §5 |
| **REC-07** | a hostile checkpoint is never deserialized on the host | `vitest run src/kernel-recovery.test.ts -t "checkpoint restore accepts only explicitly safe formats"` | pickle/pkl/dill/cloudpickle/joblib/torch/h5 refused **by name**; a pickle disguised as `.json` refused **on the bytes**; object-dtype `.npy` refused from the real header; truncated array, self-disagreeing size, zip-bomb bound and lying zlib all refused; 14/14 | **PASS (mechanism)** — see §5 |
| **REC-08** | reconnect does not auto-re-execute an ambiguous call | `vitest run src/kernel-recovery.test.ts -t "unknown side effects stay quarantined"` | `onTransportReconnect()` → `reexecuted: []`, `ambiguousCells: ['ambiguous']`, dispatched list **unchanged**, quarantine still in place; clearing it requires explicit evidenced resolution | **PASS (mechanism)** — see §5 |
| **REC-09** | a stale epoch cannot write authority | `vitest run src/durability-advanced.test.ts -t "T9-A"` + `src/durability-records.test.ts -t "D10"` | WITH the guard: `accepted: false`, reason names both epochs, state stays `accepted`, `reserved: 7`, tombstones `[]`, epoch unchanged, refusal **retained durably** in its own domain and readable by a second generation. WITHOUT the guard (via the reachable `transition`): applied, reservation released, tombstone written | **FAIL** as a product property, **PASS** as mechanism — see §3 |
| **REC-10** | the epoch guard is reachable from a production path | `node qualification/runners/import-graph.mjs` (independent compiler-based scan) + `vitest -t "T9-A"` | `recovery.ts`: `non-test importers: (NONE)`, **UNREACHABLE** from every `exports` root; the same for `reconcile.ts` (its one non-test importer, `durability-runner.ts`, is itself unreachable) and `effects.ts` | **FAIL** — the oracle explicitly names this state and forbids citing the unit test |

`[measured]` Verdict vocabulary used exactly as the spec defines it
(`NOT_RUN`, `RUNNING`, `PASS`, `FAIL`, `BLOCKED_EXTERNAL`, `NOT_APPLICABLE`). No case takes
`NOT_APPLICABLE`; the spec forbids it for every case in `cases`.

---

## 2. REC-09 and REC-10 — the two that FAIL, and why they are reported rather than worked around

`[measured]` The epoch guard is **correct and unreachable**. Two independent instruments agree
that `recovery.ts` has no non-test importer:

| Instrument | Method | Result for `recovery.ts` |
|---|---|---|
| `vitest -t "T9-A"` (this slice re-ran it, 7/7 pass) | regex specifier walk from `package.json` `exports` roots, with `host.ts` as a positive control | no production importer; **not in any entry point's transitive closure** |
| `qualification/runners/import-graph.mjs` (this slice ran it independently) | TypeScript `ts.preProcessFile` — a real parser, not a regex | `non-test importers: (NONE)`; listed under **UNREACHABLE non-test modules** |

`[measured]` `import-graph.mjs` output for this slice, verbatim:

```
=== UNREACHABLE non-test modules (6) — THE WORK QUEUE ===
  src/durability-runner.ts   non-test importers: (NONE)
  src/effects.ts             non-test importers: (NONE)   test importers: durability-advanced.test.ts, effects.test.ts
  src/kernel-lifecycle.ts    non-test importers: (NONE)   test importers: kernel-recovery.test.ts
  src/perf-metrics.ts        non-test importers: (NONE)   test importers: eco.test.ts
  src/reconcile.ts           non-test importers: src/durability-runner.ts   test importers: 6 files
  src/recovery.ts            non-test importers: (NONE)   test importers: durability-advanced.test.ts, durability-records.test.ts
TOTAL src modules: 79  non-test: 32    REACHABLE: 26   UNREACHABLE: 6
```

**REC-10's oracle is decisive and it is quoted here because it decides the verdict**: "The guard
is reachable from at least one non-test production path, and the reachability is demonstrated by
a call graph or a live boot rather than by the guard's own unit test. An epoch field that nothing
reads or writes after initialisation is INERT and is NOT PASS; the record must say so instead of
citing the unit test." `[measured]` That is exactly the state: nothing bumps the epoch after
`initialRunRecord` sets it to 1 (T9-A asserts `epochWriters === ['record.ts']`, the schema and the
initialiser), and the re-adoption path does not bump it either — `[measured]` a real SIGKILL plus a
real re-adoption leaves the record at epoch 1, and `resume()` leaves it at 1. **REC-10 = FAIL.**

**REC-09 is FAIL as a product property**, and the measurement that makes it a FAIL rather than a
PASS is the *negative* arm: `[measured]` offered to the reachable write path
(`WorkService.transition`, which takes no `epoch` parameter at all), a settlement claiming a stale
generation is simply **applied** — the task moves to `confirmed`, the reservation is released
(`reserved: 0`), a tombstone is written, `uncertainty` is `undefined`, and the record's epoch is
never consulted. There is no refusal to observe because there is no comparison to make.

So the honest reading of the pair is:

| | Guard logic | Guard reachable | Consequence |
|---|---|---|---|
| REC-09 | correct (`[measured]`: refuses, retains evidence durably) | **no** | a stale-epoch settlement that arrives through the real path is applied, not refused |
| REC-10 | — | **no** | the oracle names INERT as NOT PASS |

`[read in source]` **This is not wired by this slice, deliberately.** Wiring it is not a one-line
change: `WorkService.transition` would need an epoch parameter, *and* there is no production
ingress for a worker settlement to connect to — the only `ctx.on` subscriptions in production are
`capacity.ts`'s `agent/created` and `agent/disposed`, and no `settleChild` / `onChildResult` /
`workerSettlement` symbol exists anywhere in the package. `recovery.ts`'s own header says the same
thing. Adding a caller would fabricate the settlement edge rather than connect a real one, which
would replace one false claim ("enforced") with a worse one ("wired"). Reported, not faked.

---

## 3. REC-04 — unknown effects are never auto-replayed, but by OMISSION, not enforcement

`[measured]` At the ledger, with the dangerous scenario (remote commits, reply is lost):

| Measurement | Value |
|---|---|
| `perform` #1 — `performed` | `true` |
| `perform` #1 — `outcome` | `unknown` |
| recorded status after #1 | `unknown` (a resting state, not a retry trigger) |
| `perform` #2 — `performed` | `false` (it reconciled) |
| `perform` #2 — `outcome` | `confirmed` (established from the remote) |
| **transport invocations after 2× `perform` + 1× `reconcile`** | **1** |
| `queries` | 1 |

`[measured]` The send-decision table is exhaustive over the closed status vocabulary, and exactly
one recorded status licenses a send: `intent_recorded` (plus `absent`, the no-record case). Both
are proofs about **our own write ordering** — the `sent` marker is written *before* the transport
call, so its absence proves the call was never made. `sent`, `unknown`, `confirmed` and
`not_started` all refuse. `not_started` is the subtle one and refuses deliberately: a positive
remote statement that nothing happened is still not a licence, because resending is a new
authorization decision.

`[measured]` The strongest form: an adapter with neither an idempotency key nor a queryable result
is **never invoked** — 0 transport invocations, recorded `unknown` (not as a clean failure a
caller might retry), reason matches `/not run automatically/`.

`[measured]` On the reachable service path (`WorkService.drain`, which is what the `work` tool's
`submit` calls), a launch port that throws *after* the request was written: drain #1 → `accepted:
false`, reason `launch_failed_unknown`, task `unknown`, `budget.reserved` **held at 7**, no
tombstone; drain #2 (the replay opportunity) → refused, `already admitted as unknown`; **launch
attempts after both drains: 1**.

### The honest limit

`[measured]` `effects.ts`, `reconcile.ts` and `recovery.ts` are reachable **only from tests**
(§2). The asymmetry, stated rather than asserted:

- the product **cannot** auto-replay an unknown effect, because nothing in it reaches
  `reconcileTask` (whose every uncertain branch returns `unknown`) or `EffectLedger.perform`
  (whose only send-licensing states are proofs about our own write ordering);
- but it also **cannot refuse to**, because refusing is a decision the absent caller would have
  made. An unknown outcome is left in the record and no production path resolves it.

**So REC-04's PASS is a PASS on the mechanism, and "unknown effects are never auto-replayed" is
currently true by omission, not by enforcement. It must not be reported as a property the product
enforces.** The distinction matters because the two failure modes differ: a product that enforces
the rule refuses a replay loudly; this one never gets that far.

---

## 4. REC-03 — the missing measurement, and the positive control that makes it real

`[measured]` The tree already carried two halves of this window and neither is this one:
`D01 (simulated barrier)` shows a **refused** admission leaves no trace, in-process, with no
process dying; `D03 (REAL KILL)` shows the opposite window — the admission *did* commit, the task
*is* published (correctly), and the retry is licensed only by positive proof
(`launchProvenNotCreated`).

REC-03's stimulus is "kill the host **before** a child or cell starts" and its oracle's first half
is "**no task is published** for the interrupted attempt". So this slice wrote
`qualification/runners/v6-rec03-crash-before-admission.mjs` and measured it:

| Arm | What it does | Reopened store |
|---|---|---|
| **window** | `createRun`, then SIGKILL **before** `admit` | `runExists: true`, `taskKeys: []`, `reserved: 0`, `phase: open` |
| **control** | the **same** program **with** `admit`, killed at the same point | `runExists: true`, `taskKeys: ["t1"]`, `reserved: 7` |

Both children exited with `signal: "SIGKILL"`, `signalRequested: true`, and
`childConfirmedGone: true` (liveness re-probed after the signal, so a survivor cannot be holding
the directory when the parent reopens it). Verdict `PASS`, all 7 checks true.

**The control arm is not decoration.** A reopened store showing zero tasks cannot by itself
distinguish "the admission never committed" from "the reopen cannot see tasks at all" or "the run
was never created". The control runs the identical program with one line added and *must* show the
task and its reservation; it does.

`[measured]` The oracle's second half — "a retry is performed only for operations explicitly
established as not having taken effect" — is carried by `D03 (REAL KILL)`: a reservation whose
launch provably never happened returns to `prepared` and relaunches **exactly once** under its
**original** reserved `childId`, while a second relaunch is refused (`is accepted; only a task
proven never to have launched`), the attempt counter does not advance, and the reservation is not
re-taken. Its sibling asserts the other side: a task whose outcome is `unknown` is **never**
relaunched, even under its reserved id.

Two runner bugs were made and fixed while building this instrument, both recorded because they are
easy to repeat: (1) with `--eval` there is **no script path in `argv`**, so the child's
`[,, storeDir, reportPath]` destructuring shifted every argument by two and the store was created
at the report path, presenting as `EISDIR` in the parent; (2) the runner lives under
`qualification/runners/`, **outside** any package's `node_modules` chain, so a bare
`@deepseek-ai/cordis` import fails with `ERR_MODULE_NOT_FOUND` and the pinned checkout must be
imported through absolute `file://` URLs.

---

## 5. REC-05, REC-06, REC-07, REC-08 — the mechanism/production gap, stated per case

Three of these four cases are measured against `kernel-lifecycle.ts`'s `KernelSupervisor`, and
`[measured]` that module is **also unreachable** (`import-graph.mjs`: `non-test importers: (NONE)`,
only `kernel-recovery.test.ts` imports it). That does not make their measurements wrong; it
changes what they are measurements *of*. Stated per case:

**REC-05 — kernel death advances the epoch and names the loss.** `[measured]` Two independent
arms, and they measure different layers:
- the **reachable** layer (`dsh-ipython`, which IS reachable — `import-graph.mjs` on that package
  reports 5 reachable entry points and `kernel.ts` among them): `requirement 11` kills a real
  kernel with `taskkill /F` and asserts a new epoch, `volatileStateLost: true`,
  `previousEpoch` equal to the old epoch, a truthy reason, and a usable-but-empty replacement.
  `[measured]` separately, `IPY-12: no automatic cell replay` shows a cell that kills its own
  kernel is not re-run in the replacement (the append-only marker holds exactly one line).
- the **supervisor** layer: `kernel-recovery.test.ts`'s restart-loss block (9/9) shows the
  `unknown` decision is made **node-side** by the supervisor's own timer rather than by the
  broker, that the restart loss is named, and that a kernel which could not be restarted refuses
  further cells.

`[measured]` Note the honest scope: the reachable arm establishes epoch advance and loss naming
for a **kernel**, which is what REC-05's stimulus describes. The *run-level* epoch (the record
field REC-09/REC-10 are about) is a **different field** and it does **not** advance — see §2.
Conflating the two would be the error this family exists to catch.

**REC-06 — a checkpoint behind the last cell reports what was skipped.** `[measured]` The report
carries `checkpointAsOf`, `restored`, `lost`, `skipped`, `environmentChanged` and
`unresolvedEffects` as separate fields; `checkpointAsOf` is present **even when nothing was
restored**, so staleness is visible rather than reading as a clean state; an environment change
sets `environmentChanged: true` and says the data is not comparable; and the scope statement the
model reads contains "not full session recovery" and "No past cell was replayed". This is the
`kernel-lifecycle.ts` supervisor, so **mechanism, not production**.

**REC-07 — a hostile checkpoint is never deserialized on the host.** `[measured]` 14/14 pass:
every pickle-family format is refused **by name** (`REFUSED_FORMATS`), a pickle **disguised as
`.json`** is refused **on its magic bytes rather than its extension**, an object-dtype array is
refused from the **real `.npy` header** (its elements are pickled inside the array, so it is a
pickle under another name), and truncated arrays, self-disagreeing declared sizes, the zip-bomb
bound and an archive lying about its sizes are each refused. `[read in source]`
`validateCheckpoint` validates **without loading into a kernel** — its own doc comment says so,
and `[measured]` a bounded grep over both packages' production sources finds no
`pickle.load`/`loads`, `dill.load`, `torch.load` or `cloudpickle.load` call anywhere. Same
reachability caveat: `kernel-lifecycle.ts` is unreachable, so this is the mechanism.

**REC-08 — reconnect does not auto-re-execute an ambiguous call.** `[measured]`
`onTransportReconnect()` returns `reexecuted: []` and `ambiguousCells: ['ambiguous']`, the
transport's dispatched list is **byte-identical before and after**, the note says a reconnect is
"not that an ambiguous effect did not happen", and the quarantine is **still in place** afterwards
— a reconnect neither replays nor clears. `[measured]` A quarantine is cleared only through an
explicit evidenced resolution (an empty evidence string is refused with `without evidence`), and
resolving a cell that was never quarantined is refused. Same caveat: `kernel-lifecycle.ts`, so
this is the mechanism.

**What is NOT claimed for any of the four.** That a user can reach these paths today. See §6.

---

## 6. The mandatory prerequisite is missing — G-SEAM-31, and what it does to every claim above

`[measured]` `WorkService.createRun` has **no production caller**. On the composed profile the
model-facing `work` tool throws `this session has no active run; a run is created by user
authorization` (`qualification/results/ROOT-verification/work-tool.json`), and that measurement
carries a **positive control**: the same probe then calls `createRun` through the real API and the
tool's own lookup finds it (`controlCreateRun.ok: true`, `controlRunFoundAfterCreate: true`), so
the traversal works and the only missing thing is a caller.

`[read in source]` `docs/RECOVERY.md` opens with exactly this caveat, and it is accurate: recovery
of a **managed run** is not exercisable end to end today, so every recovery claim in this family
is a statement about the **mechanism** rather than about the product. The REC cases that reach
through `WorkService` (REC-03's control arm, REC-04's product-path arm, REC-09, REC-10) reach it
by calling the service API directly, which is the right thing to measure and is **not** the same
as a user action.

`[measured]` This is why REC-09 and REC-10 are FAIL rather than BLOCKED: their oracles are about
reachability itself, and unreachability is the measured answer, not an obstruction to measuring.
The other eight cases' oracles are about mechanism behaviour that was directly observed.

---

## 7. `docs/RECOVERY.md`'s caveats, verified rather than restated

`[read in source]` + `[measured]`, each checked against the tree:

| Claim in `docs/RECOVERY.md` | Verified how | Result |
|---|---|---|
| "an old epoch is never reused — but the guard is inert in the product" | `import-graph.mjs` + T9-A's epoch-writer scan + real SIGKILL re-adoption | **TRUE**: no production importer, no bump, re-adoption leaves epoch 1 |
| "`restartResumeAuthorized` is a BOOLEAN with no TTL — an earlier revision claimed a TTL" | `[read in source]` `record.ts:456` `z.boolean()`, `host.ts:572` `?? false` | **TRUE as a boolean.** `[read in source]` `recoveryPhase` *does* accept an `authorizationExpiresAt` parameter and expires on it, but **no production caller supplies one** and the record has no such field — so the persisted authorization has no TTL, exactly as the doc now says. The doc's correction is accurate. |
| "shutdown order matters and the naive order deadlocks" | `[read in source]` the documented sequence; the reason (a child parked in a model call cannot be torn down) | **NOT independently re-measured by this slice** — reported as the doc's own claim, and the N=10 hang it describes was measured by the capacity work, not here |
| "a run without restart authorization comes back PAUSED" | `vitest -t "D13"` (2 tests, pass) | **TRUE**: `recoveryPhase(false, …)` → `paused` with a reason; the decision is *applied* (`pause()` writes the reason to the outbox); the paused run refuses admission (`is paused; refusing admission`); `resume()` is an explicit new edge. `[measured]` a real SIGKILL arm confirms the stored flag is `false` and `reserved`/`spent` are unchanged by recovery |

---

## 8. What this slice did NOT establish

| Not established | Why |
|---|---|
| That the epoch guard is fixed | It is **not** fixed. REC-09 and REC-10 are FAIL. Wiring needs a `transition` signature change plus a settlement ingress that does not exist. |
| That the product enforces "unknown effects are never replayed" | The constraint holds **by omission** (§3). The product never reaches the reconciler, so it neither replays nor refuses. |
| That a user can reach any of these paths | `createRun` has no production caller (G-SEAM-31, §6). |
| That REC-06/07/08 are production properties | Their module, `kernel-lifecycle.ts`, is itself unreachable (§5). |
| That the shutdown-order deadlock was reproduced | Not re-measured here; taken as the doc's claim (§7). |
| That the spec on disk is the file the identity was computed over | It is **not**, as of this run — a sibling slice edited it (§11). |

---

## 9. Instruments produced by this slice

| instrument | sha256 | what it establishes |
|---|---|---|
| `tests-T9-A-B.txt` | `1fb82e945827c887dac43b9b33f98a838cb360bc4605d6997efb30f2e2f9448b` | T9-A + T9-B: **16 passed / 16 skipped (32)**, 1 file passed |
| `tests-durability-records.txt` | `ab80d48feb41e42bcaee69a062f4efef3e32fd0ab7f909c63c05df3530f0b154` | `durability-records.test.ts`: **25/25 passed** — D01, D03, D04, D05, D06, D07, D08, D09, D10, D11, D13 |
| `tests-crash-consistency.txt` | `6372cddf9dd8f2da47181a41e5927e146986e495d9586ac8ddf080831df7c56d` | REC-01: real SIGKILL, 1 orphan, 0 integrity errors, object verified |
| `tests-dat08.txt` | `cef326814b5fcea7f6000822098c8f5e5e1e5edeb0659cc833ee86a8ae48be0b` | REC-02 missing-object arm + the orphan arm + the no-re-execute rule (5/5) |
| `tests-integrity.txt` | `3185282209f9a81b576e030eb368e05606df35c8b91822b79fdfcf769f9f17fc` | REC-02 hash-mismatch + truncation arms, with the intact control (3/3) |
| `tests-effects.txt` | `8a295d7060718b7a885240aaccaca8af8dbb8f545a68ab09d7f5944e89e1cd04` | REC-04 at the ledger: **48/48 passed** |
| `tests-kernel-death.txt` | `875a5d4c1aed743e71cce77f9ccbd3779ac367680a8fbca30c6aaba5472f2f3c` | REC-05 reachable arm: real `taskkill /F` (2/2) |
| `tests-restart-loss.txt` | `403761370225838fe5dd03eed422f45f8d55c3fbec3cd55066d525458c64d7ea` | REC-05 supervisor arm (9/9) |
| `tests-recovery-report.txt` | `7abbb249995630d068737beba16afc0103f57e7f8f14a476c69b8ae4f22666ed` | REC-06: as-of/restored/lost/skipped/environment (5/5) |
| `tests-hostile-checkpoint.txt` | `7097da139001ddb1dac9284466e6acb7ca041854f6950cb5bfdf4a7875ab2790` | REC-07 (14/14) |
| `tests-quarantine-reconnect.txt` | `eb07cc965307795543aeb6ab57822e568e581c0180e35a8b19318624d41593cb` | REC-08 (4/4) |
| `tests-ipy12-no-replay.txt` | `27c8ab1e24fba6675d6febde3bc4ead397ae4d6ad254d3b27d5bb17183d3a577` | REC-04/05: a cell that kills its own kernel is not re-run (1/1) |
| `import-graph-v6.txt` | `825f8ed730e9be98cab090d649754d12aa3177c0eb783becc5a6fbf469f0434d` | REC-10: independent compiler-based reachability scan |
| `rec03-crash-before-admission.json` | `9fb0147cee74d79c70fd4ef63625c3c92562c52b9b7e14a1a677cbdf5df94d3a` | REC-03: both arms, verdict PASS |
| `source-digests.txt` | `b59ca5fce1e754a23d02ab7c76599848fc1bd3f4e726a5a26274e8a0b5cdf1f4` | build + source identity for every claim |

`[measured]` **One run failed and was investigated rather than filed.** `src/v3-spec-gates.test.ts
-t "IPY-14"` failed twice (`expected [] to have a length of 1 but got +0`, at the
nothing-was-replayed marker). It is an **untracked** file (`??`) whose mtime moved **during** both
runs (07:43:57 and 07:44:34) — a sibling slice is actively editing it — and the first run's stack
line number did not match the source line it named. Per the CPU directive it was re-run alone
before any conclusion; it is **not** reported as a defect, and the REC-05 evidence filed here does
**not** rely on it: `faults.test.ts` requirement 11 and `lifecycle.test.ts` IPY-12 carry that case
instead, and both are stable, tracked files that pass alone.

---

## 10. Files that changed under this slice

`[measured]` Nine other slices share this tree. Recorded so a reader can tell a measurement from a
moving target:

| file | state | effect on this slice |
|---|---|---|
| `qualification/specs/acceptance-spec.trusted-local-v1.json` | **edited by V5-data (committed 07:51:08), then by this slice** | its digest moved `e5b6a1d2…` → `dbe6ac01…` → `600d75bd…`; see §11 |
| `packages/dsh-ipython/src/v3-spec-gates.test.ts` | untracked, mtime moved during two runs | that file's IPY-14 case was **not** used as evidence |
| `packages/dsh-ipython/src/faults.test.ts` | `M`, mtime 07:34:36 | stable across this slice's runs; REC-05 evidence uses it |
| every `packages/dsh-daily-work/src/*` file in §0 | unchanged | all REC-01/02/03/04/09/10 evidence is against the digests recorded there |
| repo HEAD | `c3b9dba` → `07043f0` | no file this slice measures was touched by that commit |

---

## 11. The identity, stated exactly

`[measured]` At the start of this slice, `python qualification/results/T1-spec/verify-identity.py`
printed **all 28 checks passed**, with `identity recomputes from inputs: MATCH` and
`new spec digest on disk matches the pinned input: pinned=e5b6a1d2… on_disk=e5b6a1d2…`.

`[measured]` At the end, after this slice's own filing, the same script reports:

| failing check | pinned | on disk | cause |
|---|---|---|---|
| new spec digest on disk matches the pinned input | `e5b6a1d2…` | `600d75bd…` | the spec was edited — first by V5-data (twelve DATA cases, committed 07:51:08), then by this slice (ten REC cases) |
| no case is pre-marked PASS | — | offenders: `DATA-01…DATA-12` | V5-data's filing |
| no case ships with evidence | — | offenders: `DATA-01…DATA-12` | V5-data's filing |
| promotion `spec_sha256` matches the new spec on disk | `e5b6a1d2…` | `600d75bd…` | both filings |

`[measured]` **The identity literal itself still recomputes**: `identity recomputes from inputs →
computed=0a0996f3… recorded=0a0996f3… (MATCH)`. That is because the lock's
`trusted_local_acceptance_spec_sha256` is a **literal** that was not updated; the pin is now stale
against the file on disk. Three consequences, stated rather than softened:

1. **Every measurement in this file remains valid at `0a0996f3…`.** None of them is a function of
   the spec file's bytes; they are measurements of source files whose digests are recorded in §0.
2. **The spec on disk is no longer the file the identity was taken over.** The pin and the file
   have diverged. That is a real, measurable inconsistency in the identity chain, and it is
   structural: the spec's own `reading_notes.for_evidence_authors` *instructs* each slice to file
   evidence into this file, while `trusted_local_acceptance_spec_sha256` pins its digest as an
   identity input. **Any filing into this spec breaks the pin.** The first slice to file pays the
   cost, and V5-data paid it; this slice inherited it.
3. **This slice did not re-pin, and must not.** Updating the literal would move the identity to a
   new value and invalidate every PASS recorded against `0a0996f3…` by every other slice working
   in this tree right now. Re-deriving an identity is a deployment-level act with a recorded
   `identity_history` entry and a stated consequence; doing it mid-wave to make a checker go green
   is precisely the "lowering a threshold" the spec forbids. It is reported instead, as the
   finding it is: **the spec has no defined procedure for filing evidence without breaking the
   identity that binds the evidence.**

`[read in source]` The spec's own `reading_notes.for_evidence_authors` says evidence is filed under
`qualification/results/<your-slice>/` and recorded on the case with its repo-relative path and
sha256 — which is what this slice does, and which is what changed the file's digest. The tension
between "file your evidence in the spec" and "the spec's digest is a pinned identity input" is
real and is **not** resolved by this slice; it is recorded as a finding for the wave's owner.

---

## 12. Verdicts, one line each

| Case | Verdict | Basis |
|---|---|---|
| REC-01 | **PASS** | real SIGKILL → orphan, not a delivery; grace GC; control arm present |
| REC-02 | **PASS** | missing, replaced-in-place and truncated all `artifact-integrity-error`; intact control served |
| REC-03 | **PASS** | measured by this slice with a real kill and a positive control |
| REC-04 | **PASS (mechanism; by omission, not enforcement)** | 1 transport invocation across 2× perform + 1× reconcile; product path quarantines and refuses |
| REC-05 | **PASS (kernel epoch, reachable arm + supervisor arm)** | real `taskkill /F`; new epoch, loss named; run-level epoch is a different field and does NOT advance |
| REC-06 | **PASS (mechanism)** | as-of/restored/lost/skipped reported; no full-recovery claim |
| REC-07 | **PASS (mechanism)** | every pickle family refused by name and by bytes; nothing deserialized on the host |
| REC-08 | **PASS (mechanism)** | reconnect re-executes nothing and clears nothing |
| REC-09 | **FAIL** | the guard refuses correctly but is unreachable; the reachable path applies the stale settlement and releases the reservation |
| REC-10 | **FAIL** | the oracle names INERT as NOT PASS; `recovery.ts` is in no entry point's transitive closure, by two independent instruments |
