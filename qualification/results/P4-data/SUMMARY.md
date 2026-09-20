# P4 — V5 §5.1–§5.4, `dsh.data` made reachable from the product

Slice: **P0.5 — make `dsh.data` reachable from the product. Do NOT delete it.**
Worktree `D:\DSH\work\wt-p4` / branch `wt/p4`.

## The shortest real path from a boot to a `data:*` call served by the plane

```
final launcher (D:\DSH\src\dsh-src\apps\cli\lib\bin.js)
  -> DSH_HOME D:\DSH\home\p4
  -> daily profile  (presetDefaultId = daily-standard, 27 tools on the agent key)
  -> model-facing `ipython`
  -> real kernel (epoch 1)
  -> packaged Python client (packages/dsh-daily-work/src/dsh_data_client.py)
  -> bridge (onCall: lane = isDataRequest(tool) ? 'data' : 'tool')
  -> CellLease (same FIFO queue, same authority checks, same ledger)
  -> data:fs.capture
  -> the live DataPlaneService the PROFILE mounted (ctx.dailyData)
  -> result in Python: obs_78f942a2-…, 54 bytes, sha 5029cef72211fb83…
```

Measured by `qualification/runners/p4-data-driver.mjs` -> `product-e2e.json`.
Command:

```
DSH_PROBE_OUT=<this caller's path> node qualification/runners/p4-data-driver.mjs
```

**REBUILD BOTH PACKAGES BEFORE RE-MEASURING.** The profile loads built `lib/`. The
first run of the product probe measured a stale `dsh-ipython/lib/` and reported
`HAS_DATA False` — a convincing and FALSE failure. `grep -c isDataRequest
packages/dsh-ipython/lib/bridge.js` was 0 before the rebuild and 2 after.

## What changed, by file

| file | why |
|---|---|
| `packages/dsh-ipython/src/bridge.ts` | the routing branch; `DATA_TOOL_PREFIX`/`isDataRequest`; `BridgeLane`; `CellLeaseInput.dataHandler`; `CellLease.dispatchOne`; `invoke(call, lane)`; the preamble install of `dsh.data` with API-version verification; `BridgeServerOptions.dataClientPath` |
| `packages/dsh-ipython/src/kernel-plugin.ts` | `dataHandlerFor` (builds the lane from the live lease), `dataPlane()`, `dataClientPathFromPlane()` (refuses a published-but-missing client at KERNEL START), the structural `DataPlaneLike` type |
| `packages/dsh-daily-work/src/data-service.ts` | `routeData(tool, args, enclosing)` — the ONE routing entry point; `dataClientPath()`; `DATA_CLIENT_FILENAME` |
| `packages/dsh-daily-work/src/dsh_data_client.py` | `DATA_API_VERSION = 1` |
| `packages/dsh-daily-work/package.json` | `files` now ships `src/dsh_data_client.py` |
| `packages/dsh-ipython/src/p4-data-routing.test.ts` | new: 3 arms through a real kernel |
| `qualification/runners/p4-data-{product,driver}.mjs`, `.patch.yml` | new: the composition-tier probe and its driver |
| `qualification/runners/p4-pack-probe.mjs` | new: V5 §5.4 foreign-path pack test |

## Regions changed (bridge.ts is contended; P2 owns the Python client, P3 owns invoke)

| region | what |
|---|---|
| `DATA_TOOL_PREFIX`, `isDataRequest` | NEW, before `NativeCallRequest` |
| `DataCallHandler`, `BridgeLane` | NEW types |
| `CellLeaseInput.dataHandler` | NEW optional field |
| `CellLease.invoke` | signature gained `lane: BridgeLane = 'tool'`; **the authority checks are UNTOUCHED** and shared by both lanes. The default keeps every existing caller's meaning, which is why the 47+82+30 regression arms still pass |
| `CellLease.dispatchOne` | NEW, immediately before `runOne`; the only lane branch; the `DATA_NO_CAPABILITY` refusal lives here |
| `CellLease.runOne` | one line: `this.handler(...)` -> `this.dispatchOne(entry)` |
| `BridgeServer.onCall` | one line + comment: `const lane = …` passed to `lease.invoke` |
| `BridgeServerOptions`, `BridgeServer.preamble`, `renderBridgePreamble` | the data client's path and the install |
| `kernel-plugin.ts` `mintCellLease` | one added field: `dataHandler: this.dataHandlerFor(...)` |

`dsh.call` semantics are UNCHANGED: one FIFO queue, one accepted-call state
machine, `ctx.tools.execute()` still runs one complete ToolRuntime call per
`dsh.call`, no private scheduler import. No second socket family, no second
registry, no second cell authority, no second model tool.

## Concurrency, stated exactly (V5 §5.2)

Both lanes run through the SAME FIFO queue and the same accepted-call state
machine. `dsh.data` does NOT add a scheduler inside the lease and does NOT claim
ToolRuntime sibling-scheduler semantics; the bounded host-side read concurrency is
the plane's own `DataReadLimiter` (`DEFAULT_DATA_READ_CONCURRENCY = 4`), which
bounds total concurrent reads per deployment. Authorization and cancellation stay
CellLease-bound: the data lane's caller carries the LEASE's own `AbortController`
signal, so `close()` aborts an in-flight read through the one abort path that
already exists for tool calls.

## Results

| check | command | result |
|---|---|---|
| typecheck | `node helpers/typecheck.mjs` | PASS, both packages exit 0, tests included |
| seam routing | `vitest run src/p4-data-routing.test.ts` | **3 passed / 0 failed** |
| regression, bridge seam | `vitest run src/bridge-seam.test.ts` | 17 passed / 0 failed |
| regression, r5 product bridge | `vitest run src/r5-product-bridge.test.ts` | 30 passed / 0 failed |
| regression, data plane | `vitest run src/data-plane.test.ts` | 82 passed / 0 failed |
| regression, data r6 | `vitest run src/data-r6.test.ts` | 47 passed / 0 failed |
| DATA-PACKAGE (V5 §5.4) | `DSH_PROBE_OUT=… node qualification/runners/p4-pack-probe.mjs` | PASS + CONTROL arm RED |
| product e2e (V5 §5.5) | `DSH_PROBE_OUT=… node qualification/runners/p4-data-driver.mjs` | PASS + CONTROL arm RED |

## Control arms (all watched failing first)

1. **Seam, no-fallthrough**: making the no-data-plane arm fall through to the tool
   lane -> RED.
2. **Seam, pre-fix behaviour** (`lane = 'tool'` unconditionally) -> both kernel arms
   RED; the refusal became `UNKNOWN_TOOL`, i.e. the data name answered by the tool
   registry.
3. **DATA-PACKAGE**: removing `src/dsh_data_client.py` from `files` ->
   `clientPresentInTarball false` and CPython raised `FileNotFoundError` on the
   packed path.
4. **Product tier**: the same one-line revert in a REAL BOOT ->
   `dataNamesSeenByPipeline ["data:fs.capture"]`, i.e. the data name reached
   `ctx.tools.execute`. This is `G-SEAM-77` reproduced on the product tier.

## NOT_RUN / not established

- V5 §5.5's stress arms: >=32 MiB with bounded page memory, a >100 KiB single
  line, and the projection-only-reaches-model arm. The `fs.capture`/`fs.pages`
  arms ran on a 54-byte file. The plane's own 32 MiB stimulus lives in
  `data-r6.test.ts` (K7) but is NOT driven through this product path here.
- The remaining §5.5 cases (`history.search` fixed watermark, `web.search`,
  `web.fetch`, the `convert` path, attachment save/open) were not driven through
  the product path. The route now exists for all of them; only `fs.capture`,
  `fs.pages` and the unknown-op arm were exercised end to end.
- No real model turn: there is no LLM in the boot, so the model's decision to call
  `ipython` is not exercised.
- `webFetch` still passes no `convert`, so the transform stage has no plane path
  (the third break in `G-SEAM-77`). Out of this slice.
