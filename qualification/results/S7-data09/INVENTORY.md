# DATA-09 — stage inventory, with producers and reachability

Oracle (v2, verbatim): *"Produce captures that lose bytes at known stages:
provider cap, native tool cap, a lossy transform, and a storage refusal."*

Measured under: worktree `D:\DSH\work\wt-s7`, branch `wt/s7`, HEAD `fef7612`.

This file is STEP 1 of the slice: what stages currently EXIST, where they are
produced, and — the field that decides whether the case is closed — whether a
PRODUCTION path reaches each one.

## 1. The stage vocabulary (the closed set)

| fact | location |
|---|---|
| `OBSERVATION_GAP_STAGES = ['provider-acquisition','native-acquisition','transform','retention']` | `packages/dsh-daily-work/src/observations.ts:139-148` |
| `ObservationGapStage` type | `observations.ts:150` |
| `ACQUISITION_COVERAGE_STAGES = OBSERVATION_GAP_STAGES` (asserted same, not copied) | `observations.ts:166` |
| `OBSERVATION_GAP_RECOVERIES = ['page','refetch','none','unknown']` | `observations.ts:179` |
| gap schema `{stage, reason, recovery}`, reason bounded 1..4096 | `observations.ts:327-331` |
| `MAX_GAP_REASON_CHARS = 4096` | `observations.ts:313` |
| `GAP_STAGE_PRECEDENCE` (earliest-loss-first) | `observations.ts:253-258` |
| `coverageVerdictOf()` — exhaustive switch, no `default` | `observations.ts:279-295` |

The four stages map 1:1 to the four partial verdicts
(`provider-acquisition`→`partial-provider`, `native-acquisition`→
`partial-native-acquisition`, `transform`→`partial-transform`,
`retention`→`partial-storage`) at `observations.ts:287-290`.

## 2. Producers, per stage

| stage | producer | file:line | recovery emitted |
|---|---|---|---|
| `provider-acquisition` | `acquisitionFromFetch()`, on `result.truncated` | `web-provenance.ts:354-362` | `refetch` |
| `native-acquisition` | `captureFile()`, acquired-vs-persisted shortfall | `artifacts.ts:2337-2347` | `refetch` |
| `transform` | `deriveMarkdown()`, converter threw | `web-provenance.ts:499-507` | `none` |
| `transform` | `deriveMarkdown()`, converter produced empty text | `web-provenance.ts:514-522` | `none` |
| `retention` | `captureFile()`, quota refusal via `findQuotaError` cause-chain walk | `artifacts.ts:2291-2295` | `none` |
| `retention` | `captureFile()`, Session reference not committed (orphan) | `artifacts.ts:2394-2398` | `none` |
| `retention` | `captureFile()`, checkpoint failed after reference committed | `artifacts.ts:2416-2420` | `none` |

That is the COMPLETE set of `stage: '<literal>'` sites in non-test source.
Verified by `grep -rn "stage: '" --include=*.ts src/ | grep -v '\.test\.ts'`:
the only other hits are `host.ts:1170,1541,1895` `stage: 'pending'`, which is an
unrelated run-lifecycle field, not a gap stage.

## 3. Entry points that carry a gap outward

| entry point | file:line | returns gaps? |
|---|---|---|
| `DataPlane.fsCapture` | `data-plane.ts:457` | yes (via `CaptureOutcome.gaps`) |
| `DataPlane.webFetch` | `data-plane.ts:1010` | yes (`outcome.gaps`) |
| `DataPlaneService.capture` | `data-service.ts:297` | yes (`CaptureOutcome`) |
| `HistoryPlaneService.recordFetch` | `history-plugin.ts:154` | yes |
| `routeDataRequest` (the model-facing router) | `data-bridge.ts:174` | yes (`DATA_METHODS` includes `web.fetch`, `fs.capture`) |

## 4. REACHABILITY — the field that decides the case

This is the project's most-recorded defect class (V3 §2 / `docs/GAPS.md`
G-FIX-04): *the mechanism is implemented, unit-tested, correct — while nothing in
the product calls it.* So each stage is checked by CALLING the seam, not by
finding the row.

### 4.1 The routing branch the whole plane depends on DOES NOT EXIST

`data-bridge.ts:36-56` states, as an explicit contract, what writer R5's bridge
MUST do for any of this to be reachable:

> 1. In the bridge's per-call handler, before dispatch, test
>    `isDataRequest(call.tool)`.
> 2. When true, call `routeDataRequest` ...

That branch is ABSENT from the bridge. `packages/dsh-ipython/src/bridge.ts:1094`
`onCall()` reads the tool name (`:1119-1127`), looks up the lease, and calls
`lease.invoke({tool, ...})` at `:1146-1152` — unconditionally, with no prefix
test. `native-call.ts:148` then hands the name straight to `ctx.tools.execute`.

Evidence (each is a command whose output is the absence):

```
grep -rn "isDataRequest" packages/ --include=*.ts | grep -v '/lib/'
  -> only data-bridge.ts:71 (definition), :181 (self-use), data-plugin.ts:78
     (re-export), data-r6.test.ts:57 (test import). NO production caller.

grep -rn "routeDataRequest" packages/ --include=*.ts | grep -v '/lib/'
  -> only data-bridge.ts:174 (definition), data-plugin.ts:79 (re-export).
     NO production caller.

grep -rn "data:" packages/dsh-ipython/src/bridge.ts
  -> no match. The bridge has no notion of the reserved prefix.
```

**Consequence.** A cell calling `dsh.data.fs.capture(...)` sends
`{tool: 'data:fs.capture'}` over the SAME frame R5 already handles, and the
bridge routes it to `ctx.tools.execute` as a tool NAMED `data:fs.capture`. DSH
tool names are identifiers and a colon is not valid in one
(`data-bridge.ts:64-66`), so this is an unknown-tool result. The entire
`dsh.data` plane — every one of the four stages below — is therefore reachable
ONLY from a test that imports `routeDataRequest`/`DataPlane` directly.

### 4.2 The Python client is never installed, and would not ship

Even if the router existed, the client that would call it is not bound:

- `dsh_data_client.py:26-27` says the host's per-cell preamble "injects the
  `dsh` module and calls `_bind` on it" and then `install(dsh_module)` adds
  `dsh_module.data`.
- The real preamble (`bridge.ts:1245-1262`, `renderBridgePreamble`) binds the
  `dsh` module and calls `_dsh_mod._bind(...)`. It does NOT call
  `dsh_data_client.install`. `grep -n "install" packages/dsh-ipython/src/bridge.ts`
  returns nothing.
- `packages/dsh-daily-work/package.json` `files` is
  `["lib/**/*.js","lib/**/*.d.ts","cordis.patch.yml"]`, and `lib/` contains no
  `.py` (verified: `ls lib/*.py` → no match). So `dsh_data_client.py` is not in
  the published artifact set at all.

### 4.3 Per-stage reachability verdict

| stage | producer reached by product? | why |
|---|---|---|
| `provider-acquisition` | **NO** | `acquisitionFromFetch` is reached only via `provenanceFromFetch`, whose production callers are `data-plane.ts:1029` (`webFetch`) and `history-plugin.ts:168` (`recordFetch`). `webFetch` is reachable only through `routeDataRequest` (absent branch, §4.1). `recordFetch` has NO production caller (below). |
| `native-acquisition` | **NO** | `captureFile` is called by `data-service.ts:318` only; that is reached by `DataPlane.fsCapture` (`data-plane.ts:457`) → `routeDataRequest` → absent branch. |
| `transform` | **NO** | `deriveMarkdown` is called from `web-provenance.ts:1185` (`provenanceFromFetch`), and only when the caller passes `convert`. `DataPlane.webFetch` passes NO `convert` (`data-plane.ts:1029-1037` — the 4th argument is absent), so even if the router existed, the transform stage is unreachable through `webFetch`. Its only other production-shaped caller is `history-plugin.ts:154 recordFetch`, which has no production caller. |
| `retention` | **NO** | same `captureFile` chain as `native-acquisition`. |

`recordFetch` production-caller check:
```
grep -rn "recordFetch" packages/ --include=*.ts | grep -v '\.test\.ts' | grep -v '/lib/'
  -> history-plugin.ts:154 (definition) only. NO production caller.
```

### 4.4 What IS production-reachable today

The data plane's SERVICE is mounted and probeable: `data-plugin.ts` is a real
bundle row (`cordis.patch.yml:262-263`, `name: dsh-daily-work/data-host`), so
`ctx.dailyData` exists on a real boot and `DataPlaneService.open()` runs. What is
NOT reachable is any CONSUMER of it: no caller routes a request to it, and no
client binds to it. "The service is mounted" is a different fact from "a request
can reach it", and only the second one closes DATA-09.

This matches the row's own honest note at `cordis.patch.yml:231-234`: *"Its
intended model-facing caller is the M3 `python_exec`/`ipython` worker's
`dsh.data.*` namespace; the service is the stable seam that worker binds to, and
it is complete and probeable without it."* — i.e. the row itself records that the
consumer is INTENDED, not present.

## 5. Adjacent finding (not mine to fix)

`artifacts.ts` carries a high-severity cursor-MAC defect confirmed by the root
agent (`ROOT-round2/D1-cursor-mac-key-is-public.md`): the cursor MAC key is
derivable from the descriptor, so a correctly-signed forgery is accepted. A
separate writer owns that fix. Recorded here only so a reader of this inventory
knows `artifacts.ts` was under concurrent change while these line numbers were
taken; the line numbers above are for HEAD `fef7612`.
