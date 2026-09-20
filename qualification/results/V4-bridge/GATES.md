# V4 — the NATIVE BRIDGE family (BR-01 … BR-12)

**Spec:** `qualification/specs/acceptance-spec.trusted-local-v1.json`, family `NATIVE BRIDGE`, 12 cases.
**Repo:** `D:\DSH\work\dsh-native-daily` @ branch `ipython-native`, HEAD `c3b9dba`.
**Pinned DSH (read-only):** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`.
**Deployment identity:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
— re-verified this round by `python qualification/results/T1-spec/verify-identity.py`: **all 30 checks passed**.

Every claim below is labelled `[measured]` or `[read in source]`.

---

## 0. The build these cases ran against

`[measured]` The stale-build trap was addressed first: every home installs through a `link:`, so a
boot resolves the BUILT `lib/`, never `src/`.

```
cd packages/dsh-ipython
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json   # exit 0, no output
```

The rebuild was **byte-identical** to what was on disk, so `lib/` was current rather than stale:

| file | sha256 |
|---|---|
| `lib/bridge.js` | `a054d7a7d4306c7b5cbfcebb168903383ee4f84589adf3ed16c00b55c8abb20b` |
| `lib/native-call.js` | `0eb378d00eb08b99f56186ca0a09c2d39cc4a9ebd4851ba45b78a232cebec439` |

`[measured]` All digests in `source-digests.txt`. The identity recomputes (30/30).

---

## 1. THE HEADLINE, FIRST — the product does not start the bridge

**`new BridgeServer` has ZERO production call sites, and `bridge.ts` / `native-call.ts` are outside
the transitive closure of every declared entry point.** Measured by **two independent instruments
that agree**, this round, at this identity.

**Instrument A — symbol-level scan** (`probe-wiring.mjs` → `wiring.json`):

```
verdict.bridgeIsStartedInProduction: false
verdict.productionCallSites:
  createNativeCallHandler: ["packages/dsh-ipython/src/native-call.ts"]
  new BridgeServer:        []                                          <- THE FAIL
  mintLease / renderBridgePreamble / canPrependPreamble:
                           ["packages/dsh-ipython/src/bridge.ts"]      <- their own definitions
verdict.productionImportersOfBridge:     ["packages/dsh-ipython/src/native-call.ts"]
verdict.productionImportersOfNativeCall: []
```

**Instrument B — compiler-based entry-closure walk** (`qualification/runners/import-graph.mjs`, the
shared runner; output in `import-graph.txt`):

```
EXPORT ROOTS: ./host ./tool ./kernel ./plugin ./protocol
REACHABLE non-test modules: 5
UNREACHABLE non-test modules: 4
  src/bridge.ts       non-test importers: src/native-call.ts, (the two probes)
  src/native-call.ts  non-test importers: (the two probes only)
TOTAL src modules: 18   non-test: 9   REACHABLE: 5   UNREACHABLE: 4
```

`bridge.ts`'s only non-test importer is `native-call.ts`; `native-call.ts` has no production importer
at all. Both are outside the closure of every entry the package declares. Recorded as **G-SEAM-34**
in `docs/GAPS.md`, instance 10 of the defect class "mechanism implemented, tested, correct — while
nothing in the product calls it".

**The combined statement, which is the finding.** The FORBIDDEN seam is absent (§3) AND the
sanctioned one is unwired (here), so **today the model's Python has no tool access at all**. That is
worse than either half alone, because `ipython` is the model's ONLY execution surface: the composed
profile's catalog is 27 tools with `pwsh` and `bash` absent
(`qualification/results/M12-deliverable-surface/surface-fresh-install.json`).

`[measured]` **The detector was falsified, not just run.** A temporary `v4-mutation-canary.ts`
constructing a `BridgeServer` from a non-test, non-probe module made T7-07's arm FAIL, naming
`packages/dsh-ipython/src/v4-mutation-canary.ts` (`mutation-check.txt`). The canary was deleted
immediately after. So the arm that reports the FAIL is capable of reporting a PASS-shaped failure.

---

## 2. What each case rests on, and the route it was measured on

**THE DISTINCTION THIS TABLE EXISTS TO MAKE.** A case's oracle can be established on the bridge
MECHANISM while the product does not start that mechanism. Both facts are recorded per case. A
`PASS` below means "this oracle is established for the code path named"; it does **not** mean "the
model reaches it on the shipped profile", and where that gap exists it is stated in the row.

| Case | Assertion (abbreviated) | Exact command | Measured result | Verdict | Build |
|---|---|---|---|---|---|
| BR-01 | one shared policy pipeline for every call route | `node --experimental-strip-types src/v4-bridge-probe.ts` + `src/v4-bridge-approval-probe.ts` | value/guard/schema/approval all identical model-direct vs cell; no route bypasses the guard | **PASS (mechanism)** | `lib/` `a054d7a7…` |
| BR-02 | revocation during a cell takes effect | `node --experimental-strip-types src/v4-bridge-probe.ts` | in ONE cell: `first:ok` → `revoke:revoked-after-1` → `second-ERROR:UNKNOWN_TOOL`; `targetAfterTheCell: UNREGISTERED` | **PASS (mechanism)** | same |
| BR-03 | small values keep their declared type | `node --experimental-strip-types src/v4-bridge-probe.ts` | `CELL_TYPE:dict`, `CELL_IS_ARTIFACT:False`, `CELL_FIELD_TYPES:{count:int,flag:bool,marker:str,value:str}` | **PASS (mechanism)** | same |
| BR-04 | a large result executes once, delivered as a post-policy reference | `node --experimental-strip-types src/v4-bridge-probe.ts`; `vitest run src/programmatic-scope.test.ts` | bridge route: `executionsDuringTheCell: 1`, `TYPE:Artifact`, `VERIFY:True`; scope route: "runs the tool EXACTLY ONCE" + "the reference carries the POST-POLICY value" | **PASS (mechanism)** | same |
| BR-05 | a redacted value is not recoverable through its reference | `node --experimental-strip-types src/v4-bridge-probe.ts`; `vitest run src/programmatic-scope.test.ts` | `HAS_SECRET:False`, `HAS_REPLACEMENT:True`; a sweep of EVERY file in the artifact dir reports `secretAnywhereInTheArtifactDirectory: false`; scope route: post-policy BLOCK leaves no recoverable original | **PASS (mechanism)** | same |
| BR-06 | nested wrapped calls cannot deadlock the pool | `node --experimental-strip-types src/v4-bridge-approval-probe.ts`; `vitest run src/programmatic-scope.test.ts` | 12 concurrent nested calls from a cell at `maxParallel: 4` → `observedMaxConcurrency: 4`, `totalBodyRuns: 12`, cell `outcome: ok`, exclusive barrier ran | **PASS (mechanism)** | same |
| BR-07 | end-of-cell drain has a recorded disposition per call | `node --experimental-strip-types src/v4-bridge-drain-probe.ts`; `vitest run src/programmatic-scope.test.ts` | **split**: the bridge route's DRAIN holds (`revoke` waited 1499 ms for the in-flight call; a post-revoke call is refused `LEASE_REVOKED`), but the bridge route has **NO disposition vocabulary** — `disposition`/`jobId`/`handoff` appear nowhere in `bridge.ts` or `native-call.ts`. The scope route has all four dispositions | **FAIL** | `lib/` `a054d7a7…` |
| BR-08 | control notices survive and stay bounded | `node --experimental-strip-types src/v4-bridge-probe.ts` | `noticeCount: 1` (106 control bytes ferried), `concludedTurnCount: 1`, bulk image 4096 B returned with `contentBytesEnteringModelContextViaTheBridge: 0` | **PASS (mechanism)** | same |
| BR-09 | the kernel cannot forge host-authored facts | `node --experimental-strip-types src/v4-bridge-probe.ts`; `vitest run src/data-plane.test.ts -t "observation authority"` | wire: the bridge's 7 authority fields ALL → `FORGED_AUTHORITY`; the oracle's other examples (`id`, `captured`, `captured.sha256`) are **SERVED, not refused** — but the forged key never reaches the handler (`forgedFieldReachedTheHandler: false`, received keys are exactly the 6 transport fields). Data plane: type+wire refusal of the same paths | **PASS, with a recorded precision** | same |
| BR-10 | scope close is explicit and leaves no unsettled call | `node --experimental-strip-types src/v4-scope-probe.ts` | for EACH of `completed`/`aborted`/`error`: 5 submitted → 5 dispositions, `uniqueSubCallIds: 5`, `everyDispositionCarriesTheCloseReason: true`, `everyCallReachedATerminalState: true` | **PASS (mechanism, scope route)** | same |
| BR-11 | content projection follows the declared mode and is counted | `node --experimental-strip-types src/v4-scope-probe.ts` | `reference` → 0 B to model context, 187 B retained; `defer-images` → 4114 B to model context (4096 of it image), 0 B retained; `modesDifferAsRequired: true` | **PASS (mechanism, scope route)** | same |
| BR-12 | the deployment depth ceiling cannot be lifted by the caller | `node --experimental-strip-types src/v4-bridge-approval-probe.ts`; `vitest run src/capacity.test.ts` | from a cell: `maxDepth: 99` → `DEPTH_CEILING_EXCEEDED`, ceiling 1, 1 refusal recorded; deployment gate: maxDepth 99 AND omitted both REFUSED | **PASS (mechanism)** | same |

**The reachability FAIL is not a case here, and that is deliberate.** G-SEAM-34 is a fact about the
COMPOSITION, not about any single BR oracle: every BR case above asks whether the bridge behaves
correctly, and it does. The FAIL is recorded in §1 and in `docs/GAPS.md`, and it is what a reader
must carry alongside every PASS in the table.

---

## 3. The forbidden seam is ABSENT — three ways, carried from T7 and re-confirmed

`[measured]` The constraint: **严禁把 `ctx.terminalController` 用作模型 Python 能力**.

1. **No source file in the package names it.** T7-08 walks every non-test `.ts` in
   `packages/dsh-ipython/src/`; zero offenders. Re-run this round: the arm passes.
2. **No composition mounts one.** `qualification/results/T7-bridge/terminalController-scan.txt`: a
   scan of `packages/` and `profiles/` returns hits ONLY in `*.test.ts`, every one an assertion that
   it is ABSENT. Production code and profiles: zero hits.
3. **The cell's host-owned namespace is exactly `['dsh']`**, zero terminal-named modules, and the
   client surface is `['Artifact','BridgeError','call','call_sync','tools']` with
   `CLIENT_HAS_TERMINAL: False`.

`[measured]` **The near-false-finding, recorded rather than repeated.** A real IPython kernel loads
**14** modules with `terminal` in the name (`IPython.terminal.*`). They are IPython's OWN console
machinery, predating this package, and say nothing about the constraint. The assertion measures the
HOST's namespace contribution, not "any module named terminal". Loosening the pattern instead would
have stopped the test distinguishing anything.

---

## 4. Where each measurement lives

| File | What it is |
|---|---|
| `v4-bridge-probe.json` | `[measured]` the bridge-route arms: BR-01/03 (value, guard, schema), BR-02 (revocation), BR-04 (one execution + artifact), BR-05 (redaction sweep), BR-08 (notices + bulk image), BR-09 (forged fields), BR-12 (frame surface) |
| `v4-bridge-approval-probe.json` | `[measured]` BR-01's APPROVAL arm on both routes, BR-06 (observed max concurrency + exclusive barrier), BR-12 (depth refusal from a cell) |
| `v4-bridge-drain-probe.json` | `[measured]` BR-07 on the BRIDGE route: a cell returning with a call in flight, what the host surfaces show, and whether the lease drain waits |
| `v4-scope-probe.json` | `[measured]` BR-10 for all THREE close reasons, BR-11 with delivered/retained byte counts |
| `wiring.json` + `probe-wiring.mjs` | `[measured]` instrument A — the symbol-level wiring scan, with an explicit PROBE_FILES set |
| `import-graph.txt` | `[measured]` instrument B — the compiler-based entry-closure walk |
| `tests-bridge-seam.txt` | `[measured]` `vitest run src/bridge-seam.test.ts`, 17/17 |
| `tests-programmatic-scope.txt` | `[measured]` `vitest run src/programmatic-scope.test.ts`, 42/42 |
| `tests-capacity.txt` | `[measured]` `vitest run src/capacity.test.ts`, 41 passed + 1 expected fail |
| `tests-observation-authority.txt` | `[measured]` `vitest run src/data-plane.test.ts -t "observation authority"`, 5/5 |
| `mutation-check.txt` | `[measured]` the canary that proves the wiring detector still bites |
| `source-digests.txt` | `[measured]` build identity and source digests |
| `file-br-cases.py` | the filing script: the case → evidence → note mapping, auditable and re-runnable |

---

## 4a. TWO PRECISIONS THE MEASUREMENT FORCED, recorded because both changed a verdict

### BR-09: the refusal covers the bridge's own authority list, NOT the oracle's whole example set

`[measured]` BR-09's oracle says a claim carrying "host-authored fields **such as** `id`,
`captured.sha256`, `captured.bytes` or `authority.*`" is REFUSED. The bridge refuses exactly its own
seven: `authority`, `agent`, `session`, `sessionId`, `rootCallId`, `parent`, `parentToken` — all
`FORGED_AUTHORITY`. But `id`, `captured` and `captured.sha256` are **not in that list**, and frames
naming them were **SERVED**.

**Why this is still a PASS, stated as a measurement rather than a rationalisation.** A served frame
is only a forgery if the field REACHES the executor. So the handler's own received keys were
recorded for every call: `receivedKeys` is exactly `arguments, cellId, epoch, leaseId, requestId,
tool` in all four served frames — the forged key was **DROPPED, never merged**, and
`forgedFieldReachedTheHandler: false`. A program cannot promote a claim by naming a field the host
ignores.

**The other half, which is where those exact paths ARE refused.** `captured.sha256`, `captured`,
`captured.bytes`, `authority`, `authority.ownerScope` and `id` are all in
`HOST_AUTHORED_PATHS` (`observations.ts:338`), and `refuseForgedClaims` refuses a kernel payload
asserting any of them, naming every offending path, with code `observation-authority-forged` —
**before anything is written**, so a forged capture cannot cause an effect. That is the boundary
where a kernel claim actually enters the data plane, and it is measured in
`tests-observation-authority.txt` (5/5). The two defences are at two different layers, and the
oracle's "type-level defense plus the wire-level refusal" is satisfied by exactly that pair.

### BR-07: the bridge route has a DRAIN but no DISPOSITION VOCABULARY — this is a FAIL

`[measured]` BR-07's stimulus names a CELL, and its oracle requires every in-flight call to carry one
disposition from `settled`/`cancelled`/`handed-to-jobs`/`abandoned-unstarted`, with a job id for a
handoff. The SCOPE route implements that vocabulary and it is measured. **The BRIDGE route does not**:
a grep of `bridge.ts` and `native-call.ts` for `disposition`, `jobId` and `handoff` returns nothing,
and the live `CellLease` object's own keys and prototype methods are
`id, sessionId, cellId, epoch, handler, inFlight, seenRequestIds, revoked` and
`live, revokedReason, invoke, revoke` — no disposition surface.

**What the bridge route DOES do, measured on a real cell.** A cell started a call without awaiting it
and returned (`CELL_RETURNED_WITH_TASK_PENDING:True`, `slowStarted:1`, `slowFinished:0`,
`registryResults:[]`). The lease's `revoke` then **waited 1499 ms** for that call to finish before
resolving, and a call arriving after the revoke was refused `LEASE_REVOKED`. So the
"nothing continues silently" half is satisfied by a drain barrier — and the "a recorded disposition
per call" half is not, because the record the bridge keeps is a request-id set, not a disposition.

**Why this is filed FAIL rather than PASS on the scope route.** The scope is not the bridge: the
bridge calls `ctx.tools.execute` directly and does not route through the scope service. Filing the
scope's dispositions as this case's evidence would be the weaker-oracle substitution this project's
audit exists to catch. The drain half is recorded so a reader can see the mechanism is not simply
absent — but the oracle asks for a disposition per call, and on the cell route there is none.

---

## 5. Two things this gate changed, and why

### 5a. A real defect T7 found and fixed — carried, not re-claimed

`bridge.ts`'s client docstring promises every error arrives as `BridgeError` with a code. Measured
before the fix, the ASYNC path leaked a bare `TimeoutError` with no `.code`, while `call_sync` raised
`BridgeError("TIMEOUT")` for the same condition — a program branching on `except BridgeError` crashed
on one path and worked on the other. Fixed in `bridge.ts`; the assertion that pins it is the
`CODE:TIMEOUT` arm, which fails without the fix. This gate re-ran that arm: it passes.

### 5b. This gate edited ONE line of a measured subject, and states it

`packages/dsh-ipython/src/bridge-seam.test.ts`, T7-07's second arm, classified hand-run measurement
drivers with the regex `/[\\/]t\d+-measure\.ts$/`. This gate's driver is `v4-bridge-probe.ts`, which
that pattern does not match, so **the arm failed reporting a PROBE as a production caller of
`new BridgeServer`** — a false positive in the direction that hides the real defect.

Three responses were available and two were rejected:
- **Loosening the pattern** — rejected: it would let a real caller through.
- **Renaming the probe to fit the detector** — rejected: that is making a detector quiet by moving
  the subject, which is the move this project keeps recording as a defect.
- **An explicit `PROBE_FILES` set** — taken. A new probe must be ADDED to the list, which is a
  deliberate act a reviewer sees in the diff.

A first version of that fix compared the ABSOLUTE path against repo-relative keys, matched nothing,
and made the arm report BOTH probes as callers. Running it caught that, which is why the arm is
exercised rather than reasoned about.

---

## 6. What is NOT claimed

- **Not claimed:** that the product starts the bridge. The opposite is measured (§1).
- **Not claimed:** that the model's Python reaches any DSH tool on the composed profile. It does
  not — the forbidden path is absent AND the sanctioned path is unwired.
- **Not claimed:** that the scope route is the model's route. The scope service IS wired
  (`cordis.patch.yml` row `daily-programmatic-scope`), but the IPython bridge does **not** route
  through it: `native-call.ts` calls `ctx.tools.execute` directly. BR-07/BR-10/BR-11 are marked
  "scope route" above for that reason.
- **Not claimed:** any isolation. This deployment's trust model claims none.
- **Not claimed:** the wiring scan is a proof about files outside `packages/` and `profiles/`. The
  walk is bounded to those trees to a capped depth, which is where a composition would live here.
