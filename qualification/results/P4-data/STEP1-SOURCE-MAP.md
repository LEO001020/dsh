# P4 / G-SEAM-77 — source map and routing fix (step 1)

Slice: **P0.5 — make `dsh.data` reachable from the product. Do NOT delete it.**
Worktree `D:\DSH\work\wt-p4` / branch `wt/p4`.

This file is written BEFORE the fix is finished so the map survives a model error.
Everything below was read from source in this worktree.

---

## 1. The defect, re-verified (not taken on trust)

```
$ grep -c "data:" packages/dsh-ipython/src/bridge.ts
0
```
BEFORE this commit. The plane is complete and nothing calls it:

| symbol | where it is DEFINED | who CALLS it (before) |
|---|---|---|
| `isDataRequest(tool)` | `packages/dsh-daily-work/src/data-bridge.ts:71` | only `data-bridge.ts:181` itself + `data-r6.test.ts` |
| `routeDataRequest(plane, caller, tool, args)` | `data-bridge.ts:174` | only `data-r6.test.ts:982,1002,1017,1033` |
| `dataCallerFromEnclosing(authority)` | `data-bridge.ts:105` | only tests |
| re-export | `data-plugin.ts:74-81` | nothing in production |
| `DataPlaneService` (`ctx.dailyData`) | `data-service.ts:169`, mounted by `data-plugin.ts:48` via the `dsh-daily-work/data-host` row (`cordis.patch.yml:263`) | the SERVICE is mounted on a real boot; no CONSUMER is |

`G-SEAM-77` records three further breaks beyond the missing route:
1. `dsh_data_client.install` is never called (`bridge.ts` bind path calls only `_bind`);
2. the `.py` is not in either package's `files`;
3. `webFetch` passes no `convert`, so the transform stage has no plane path.

## 2. The dispatch point, exactly

- `BridgeServer.onCall` — `packages/dsh-ipython/src/bridge.ts:1130` (BEFORE this commit).
  It validates the frame (forgery check at `:1140`, tool-name check at `:1154`),
  resolves the lease (`:1168`) and calls `lease.invoke({...})` at `:1184`.
- `CellLease.invoke` — `bridge.ts:491`. Runs the authority checks in order:
  lease OPEN → epoch → cellId → leaseId → idempotency, then accepts the call into
  the FIFO queue and writes durable STARTED before any dispatch.
- `CellLease.runOne` — `bridge.ts:786`. Called `this.handler(...)` at `:789`;
  this was the unconditional path to `ctx.tools.execute`.
- The handler is built by `createNativeCallHandler` (`native-call.ts:125`), which
  calls `ctx.tools.execute(input)` at `native-call.ts:148`.

**The branch belongs in `onCall` (the lane decision) and in `runOne` (the lane
dispatch).** Routing before `invoke` would bypass the authority checks, so the
lane is passed INTO `invoke` instead.

## 3. What `routeDataRequest` returns, and how it must be carried

`DataRouteOutcome` (`data-bridge.ts:115`):
```ts
{ ok: true, value: unknown } | { ok: false, error: { code: string, message: string } }
```
`NativeCallOutcome` (`bridge.ts:180`) is the SAME shape plus one extra success arm:
```ts
{ ok: true, value: unknown } | { ok: true, artifact: BridgeArtifact } | { ok: false, error: BridgeFailure }
```
So a `DataRouteOutcome` is a strict subset and maps across with NO conversion:
`{ok:true,value}` and `{ok:false,error:{code,message}}` are already valid
`NativeCallOutcome` arms. The lane is therefore indistinguishable downstream —
same accepted-call state machine, same idempotency table, same durable ledger,
same `deliver()` size door (inline vs artifact).

Unknown `data:*` op: `routeDataRequest` catches its own `DataPlaneError` and
returns `{ok:false,error:{code:'DATA_INVALID_REQUEST', message:...}}`
(`data-bridge.ts:396-402`). It never throws for a plane-level refusal, so it
cannot escape into the tool lane by throwing.

## 4. Where `dsh.data` must be installed at bind time

- `renderBridgePreamble` — `bridge.ts:1282` (BEFORE this commit). It builds the
  per-cell preamble: creates/reuses the `dsh` module, `exec`s the client source
  into it, then calls `_dsh_mod._bind(port, token, leaseId, cellId, epoch)` and
  binds `dsh = _dsh_mod`.
- **The bind path HAS a place for it**: immediately after `_bind`, before
  `dsh = _dsh_mod`. `dsh_data_client.install(dsh_module)` expects exactly that
  module object and reads `dsh_module._channel.call_async` (the bridge client's
  own attribute, which exists — `bridge.ts:1632` `_channel = _Channel()` and
  `call_async` at `:1536`).
- `canPrependPreamble` — `bridge.ts:1307`. A `%%` cell magic gets NO preamble, so
  `dsh` (and therefore `dsh.data`) is absent for those cells. That is a known,
  pre-existing property of the preamble mechanism (and is what V5 §9 wants
  removed by a different route); it is NOT introduced here.

## 5. Packaging gap, measured

```
$ find . -name "dsh_data_client*" -not -path "*/node_modules/*"
./packages/dsh-daily-work/src/dsh_data_client.py
```
- `dsh-ipython/package.json` `files`: `lib/**/*.js`, `lib/**/*.d.ts`,
  `src/broker.py`, `cordis.patch.yml` — ships a `.py` from `src/` already
  (`src/broker.py`), which is the precedent to follow.
- `dsh-daily-work/package.json` `files`: `lib/**/*.js`, `lib/**/*.d.ts`,
  `cordis.patch.yml` — ships NO `.py`.
- Neither package's `files` includes `dsh_data_client.py`.

**The bridge client is a DIFFERENT mechanism** and needs no packaging:
`BridgeServer.start()` (`bridge.ts:939-946`) writes `PYTHON_CLIENT_SOURCE` (a TS
template string, `bridge.ts:1325`) to `clientDirectory ?? artifactDirectory` as
`dsh_bridge_client.py` at runtime. It ships as code, not as a file.

**Cross-package resolution, MEASURED** (this decides option (b)):
```
$ node -e "createRequire('.../wt-p4/packages/dsh-ipython/lib/bridge.js').resolve('dsh-daily-work/package.json')"
dsh-daily-work UNRESOLVABLE (MODULE_NOT_FOUND)
```
`dsh-ipython/node_modules/` holds only `@deepseek-ai`, `@types`, `koffi`, `tsx`,
`vitest`, `zod` — no sibling link. From the PROFILE's directory it does resolve
(`profiles/daily/node_modules/` symlinks both), but a package must not depend on
being resolved from the profile root.

## 6. The routing change (this commit)

`packages/dsh-ipython/src/bridge.ts` only:

| function | region | change |
|---|---|---|
| `DATA_TOOL_PREFIX`, `isDataRequest` | ~`:186` (new) | the reserved prefix, defined locally because the cross-package import is unresolvable (§5) |
| `DataCallHandler`, `BridgeLane` | ~`:211`, ~`:375` (new) | the second internal dispatcher's type and the lane tag |
| `CellLeaseInput.dataHandler` | ~`:300` (new field) | optional second dispatcher; ABSENT = REFUSED, never fallen through |
| `CellLease.invoke(call, lane='tool')` | `:491` | lane is a parameter with a default, so no existing caller changes meaning; authority checks unchanged and shared |
| `CellLease.dispatchOne` | new, before `runOne` | the lane branch; the no-data-plane refusal (`DATA_NO_CAPABILITY`) lives here |
| `CellLease.runOne` | `:786` | calls `dispatchOne` instead of `this.handler` directly |
| `BridgeServer.onCall` | `:1182` | `const lane = isDataRequest(tool) ? 'data' : 'tool'` passed to `lease.invoke` |

`dsh.call` semantics are UNCHANGED: one FIFO queue, one accepted-call state
machine, `ctx.tools.execute()` still runs one complete ToolRuntime call per
`dsh.call`, no private scheduler import. The data lane is protected by the SAME
authority checks because it passes through the same `invoke`.
