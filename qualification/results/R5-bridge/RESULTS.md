# R5 — F2 production bridge: measured results

Every number here was measured on THIS worktree's build
(`D:\DSH\work\wt-r5`), with `packages/dsh-ipython` compiled from this tree's
`src/` into this tree's `lib/`. The build identity is stated because this
project filed two FALSE findings (G-SEAM-29, G-SEAM-36) by measuring a stale
`lib/` and a hand-built harness, and retracted both.

## Before / after, from the SAME instrument

`src/r5-f2-before.ts` is the reachability + vocabulary instrument. It was run
BEFORE any edit and again after, so the pair is comparable rather than a
changelog's claim.

| measurement | `F2-before.json` | `F2-after.json` |
|---|---|---|
| `bridge.ts` reachable from the package's `exports` roots | **false** | **true** |
| `native-call.ts` reachable | **false** | **true** |
| `new BridgeServer` production call sites | **[]** | `kernel-plugin.ts`, `ipython-tool.ts` (mention only) |
| non-test importers of `native-call.ts` | **[]** | `kernel-plugin.ts` |
| `disposition`/`jobId`/`handoff` on the bridge route | **0/0/0** | 44/9/12 |
| the same three words on the scope route | 21/5/7 | 21/5/7 (unchanged) |

The last row is the control: the scope route was not touched, so the vocabulary
it already had is unchanged while the bridge route went from nothing to the same
four words.

## Composition tier: a REAL `daily` boot

`qualification/runners/r5-bridge-driver.mjs` boots the real `daily` profile
through the port-safe harness (`--port 0` semantics via `freePort()`), then
`r5-bridge-product.mjs` runs inside that boot. Archived at
`composition-tier.json`.

```
presetDefaultId            daily-standard        (the profile's OWN default)
kernelServicePresent       true
ipythonToolPresent         true                  toolCountAgentKey 28
bridgePresentAfterBoot     true                  endpoint port 4191, protocol 1
kernelEpoch                1                     kernelLifecycle READY
bridgeLeasesAtRest         0
toolCallOutcome            ok
cell stdout                DSH_BOUND=True
                           CELL_VALUE={"marker":"R5-COMPOSITION","tag":"from-a-real-boot"}
nested dispatch            r5-composition-outer-1:ipython:1
ledger                     durable, disposition `settled`, STARTED+SETTLED both set
portReleased               true
```

The durable ledger is on disk at
`D:\DSH\home\r5\storages\dsh_ipython_bridge_ledger.json` — the SAME storage
domain the profile already mounts for the run record and the data plane. No
second SQLite database was added and no custom Session event was appended
(V3 §J6 / brief §5.14).

## The defect the composition tier found

The first real boot failed every `dsh.call` with:

```
BridgeError: BRIDGE_FAILED: cannot get property "tools" without inject
```

`host-plugin.ts` injected only `['subprocess']`. The service's OWN context had
not injected `tools`, so `ctx.tools.execute` threw from inside the bridge. The
code-path tests hand the service a context that mounted `ToolRuntime` directly,
so they passed 17/17 while the PRODUCT failed on the first real cell — F2's own
shape one layer down. Fixed in `host-plugin.ts`; the measurement is quoted in
that file and in `KernelService`'s own `static inject`.

## Does the ledger persist a capability?

Root asked this because of G-SEAM-59 (the connection file lands in a temp
directory whose ACL grants `Modify`, so a principal could replace it and
substitute its own keys). The answer, read off the schema and the on-disk row:

**No.** `bridgeCallRecordSchema` carries `subCallId`, `sessionId`,
`kernelEpoch`, `cellId`, `outerCallId`, `rootCallId`, `requestId`, `argsDigest`,
`name`, the two timestamps, `isError`, `resultDigest`, `resultBytes`,
`artifactRef`, `disposition`, `jobId`, `closeReason`. The on-disk row at
`D:\DSH\home\r5\storages\dsh_ipython_bridge_ledger.json` confirms it: no token,
no key, no connection-file path, no curve material.

What IS capability-adjacent and where it lives:

- The **per-kernel bridge token** is held in memory on `BridgeServer`
  (`kernelToken`, rotated on restart) and delivered to a cell only inside that
  cell's preamble. It is never written to the ledger and never logged.
- The **lease id** is a `randomUUID` held in memory, also never written.
- The **artifact directory** for oversized results is
  `<kernel scratch>/<session>/bridge/artifacts`, under the package's own
  `.ipython-kernels` root — inside the tree, not in the system temp directory.
- The **broker's connection file** is untouched by this slice; its location is
  `broker.py`/`jupyter_client`'s business and G-SEAM-59 remains open and is NOT
  fixed here, per Root's instruction.

So the same location question does not transfer to the ledger: it persists
occurrence records and digests, not a credential.

## Test files run (one at a time, per the brief's CPU rule)

| file | result |
|---|---|
| `r5-product-bridge.test.ts` (new) | 21/21 |
| `bridge-seam.test.ts` (T7-07 inverted) | 17/17 |
| `v3-spec-gates.test.ts` | 12/12 |
| `requirements.test.ts` | 19/19 |
| `lifecycle.test.ts` | 15/15 |
| `faults.test.ts` | 11/11 |
| `service.test.ts` + `protocol.test.ts` + `smoke.test.ts` + `cleanup.test.ts` | 28/28 |
| `tsc -p tsconfig.check.json --noEmit` | exit 0 |

The full suite was NOT run: the brief forbids it, and the files touched are all
above.

## What is NOT measured

- **No real model turn.** There is no LLM in the composition boot; the probe
  calls `ctx.tools.execute` with the `ipython` tool's name, which is what the
  agent loop does, but the model's decision to call the tool is not exercised.
  `live_provider_budget_authorized: false` on this deployment.
- **`handed-to-jobs` is not reachable in the default composition**, because no
  `jobHandoff` is configured. The arm is implemented and its ledger rule is
  tested directly; the production wiring for it is a later slice's.
- **The ledger's durable write is proven against the JSON backend only.** A
  different storage backend is untested.

