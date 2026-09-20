# DATA-09 — findings, verbatim gap records, and per-stage reachability

Oracle (v2, verbatim): *"Produce captures that lose bytes at known stages:
provider cap, native tool cap, a lossy transform, and a storage refusal."*

Measured under: worktree `D:\DSH\work\wt-s7`, branch `wt/s7`.
Commands and their raw output are in this directory. Step 1's inventory is
`INVENTORY.md`.

## 1. The four stages, driven, with the gap record verbatim

All four arms live in `packages/dsh-daily-work/src/data-r6.test.ts`, describe
block `DATA-09`. Each has a CONTROL arm that must report no gap.

| stage | stimulus | `completeness` | `recovery` | control arm |
|---|---|---|---|---|
| `provider-acquisition` | stub provider returns `truncated: true` through the real `ctx.web.fetch` | `partial` | `refetch` | untruncated → `complete-within-request`, 0 gaps |
| `native-acquisition` | `captureFile` with a reader that yields 1024 of a 4096-byte file | `partial` | `refetch` | full read → `complete-within-request`, 0 gaps |
| `transform` | converter throws / returns whitespace only | (gap on the derivation) | `none` | successful convert → derived bytes, no gap |
| `retention` | real store quota 16 KiB vs a 64 KiB source | `partial` | `none` | (K7's existing complete-path arms) |

The gap records the producers actually emit, copied from the source at this pin:

```
// web-provenance.ts:354-362  (provider cap)
{ stage: 'provider-acquisition',
  reason: 'the provider capped the body at <N|its default bound>; <n> characters were delivered
           and the remainder was never sent to this process',
  recovery: 'refetch' }

// artifacts.ts:2338-2346  (native tool cap)
{ stage: 'native-acquisition',
  reason: 'the source was 4096 bytes at capture start but only 1024 were acquired (3072 bytes
           never reached the store); the captured object is the bytes that DID arrive, not the
           file that was named',
  recovery: 'refetch' }

// web-provenance.ts:499-507 / :514-522  (lossy transform, both shapes)
{ stage: 'transform',
  reason: 'the <name>@<version> conversion threw: <msg>; the raw artifact is the only content available',
  recovery: 'none' }
{ stage: 'transform',
  reason: 'the <name>@<version> conversion produced no text; the raw artifact may still contain
           content (e.g. text inside script/JSON payloads)',
  recovery: 'none' }

// artifacts.ts:2291-2295  (storage refusal)
{ stage: 'retention',
  reason: '<the quota error message, found through the CAUSE CHAIN>',
  recovery: 'none' }
```

## 2. Attribution: CORRECT in all four. No misattribution found.

Each stage is filed under itself, and the recovery value is honest for the
reason that makes it distinct:

- **provider cap → `refetch`.** The bytes were never sent to this process, so no
  local object holds them. `page` would be a false promise. Correct.
- **native tool cap → `refetch`.** The file is still on disk and a second read
  can return the rest. `page` would be wrong (the missing bytes are in no object
  this plane holds). Correct.
- **lossy transform → `none`.** The raw artifact is complete and untouched; only
  the DERIVATION is missing. A re-ask of the world cannot help, and the raw
  object is still there. Correct — and note this is the arm that would catch a
  reflexive `refetch`.
- **storage refusal → `none`.** A retry against the same ceiling fails the same
  way. Correct.

### 2.1 A FABRICATED gap found and fixed: an OVER-read filed as a loss

Attribution was correct in the four arms above, but probing the SAME producer in
the opposite direction found a real defect in the guard.

`artifacts.ts` computed `shortBy = sourceBytesAtStart - published.bytes` and
branched on `shortBy !== 0`, with `completeness: shortBy === 0 ? ... : 'partial'`.
When MORE bytes arrive than `stat` saw, `shortBy` is NEGATIVE — nothing was
withheld, so there is no loss — and the `!== 0` guard filed one anyway.

Measured, before the fix (`FINDING-negative-shortby-false-loss-gap.txt`): a
4096-byte source with an 8192-byte reader produced

```
completeness  partial
verdict       partial-native-acquisition
gap.stage     native-acquisition
gap.recovery  refetch
gap.reason    the source was 4096 bytes at capture start but only 8192 were acquired
              (-4096 bytes never reached the store); the captured object is the bytes
              that DID arrive, not the file that was named
```

A negative count of bytes that never went missing. This is DATA-09's own failure
mode reached through the SIGN of the difference rather than through a wrong stage
name: a reader who believes that record re-asks for bytes they already hold, and
a `partial` verdict is asserted over a capture that lost nothing.

**Fix** (`artifacts.ts`, committed `644bc3f`): the guard is now `shortBy > 0` and
completeness `shortBy <= 0 ? 'complete-within-request' : 'partial'`, so only a
POSITIVE shortfall is a partial capture. The new test arm was watched FAIL FIRST
(`FINDING-negative-shortby-RED-FIRST.txt`: `AssertionError: an OVER-read is not a
loss, so it must record no gap: expected [ { …(3) } ] to have a length of +0 but
got 1`), then the fix applied and the arm went green.

This is a real product bug in a production path (`captureFile`), but note its
reachability is the SAME as the `native-acquisition` stage's: it needs a caller
that can inject a reader, which the plane cannot (§4.4a). So the fix is correct
and the defect was real, and it was not reachable from the assembled product
either — the same honest caveat applies to it.

`coverageVerdictOf` (`observations.ts:279-295`) maps each stage to its own
verdict, and the mapping is an exhaustive switch with NO `default`, so adding a
stage without deciding its verdict is a compile error rather than a silent
`unknown`. A `partial` record with NO gap reports `unknown` — not a layer — which
is the arm that stops the fallback from silently becoming `partial-storage`.

Precedence is earliest-loss-first (`observations.ts:253-258`) and was driven in
both insertion orders, so the reported verdict cannot be an artifact of gap
ordering.

## 3. Mutation test: the gate goes red. Three mutations, all restored.

Each mutation was applied to PRODUCTION code, the file run, the failure captured,
and the file restored with `git checkout HEAD -- <path>` (verified: `git diff`
empty afterwards, and the suite green at 47/47).

| # | mutation | result | captured evidence |
|---|---|---|---|
| 1 | `artifacts.ts:2292` `stage: 'retention'` → `'native-acquisition'` | RED, 2 failed | `mutation-1-retention-stage-misattributed.txt` |
| 2 | `web-provenance.ts:506` transform `recovery: 'none'` → `'refetch'` | RED, 1 failed | `mutation-2-transform-recovery-refetch.txt` |
| 3 | `web-provenance.ts:355` `stage: 'provider-acquisition'` → `'retention'` | RED, 2 failed | `mutation-3-provider-stage-misattributed.txt` |

The exact assertions that fired:

```
#1  AssertionError: an over-quota capture must record where the bytes went: expected undefined to be defined
    AssertionError: a quota refusal must be filed under retention: expected undefined to be defined
#2  AssertionError: expected 'refetch' to be 'none' // Object.is equality
#3  AssertionError: a capped body must record WHERE the bytes went: expected undefined to be defined
    AssertionError: a provider-capped body must be filed under provider-acquisition: expected undefined to be defined
```

Mutations 1 and 3 also reddened the PRE-EXISTING K7 and K3 arms, which is worth
noting: those arms already covered attribution for two of the four stages, so the
DATA-09 block's new coverage is the native-tool-cap and transform arms plus the
cross-stage properties (distinctness, totality, precedence) and the controls.

## 4. PRODUCT REACHABILITY — the finding. NONE of the four is reachable.

This is the field that matters, and the answer is negative for all four. The
mechanism is implemented, unit-tested, and correct; nothing in the product calls
it. This is the defect class V3 §2 says has now been recorded more than twelve
times.

### 4.1 The routing branch does not exist

`data-bridge.ts:36-56` states as an explicit contract what writer R5's bridge
MUST do: test `isDataRequest(call.tool)` in the per-call handler and route to
`routeDataRequest`. That branch is ABSENT.

- `packages/dsh-ipython/src/bridge.ts:1094` `onCall()` reads the tool name
  (`:1119-1127`), looks up the lease, and calls `lease.invoke({tool, ...})` at
  `:1146-1152` — unconditionally, with no prefix test.
- `native-call.ts:148` hands the name straight to `ctx.tools.execute`.
- `grep -rn "data:" packages/dsh-ipython/src/bridge.ts` → no match. The bridge has
  no notion of the reserved prefix.

A cell calling `dsh.data.fs.capture(...)` sends `{tool: 'data:fs.capture'}`, which
the bridge routes to `ctx.tools.execute` as a tool NAMED `data:fs.capture`. DSH
tool names are identifiers and a colon is not valid in one
(`data-bridge.ts:64-66`), so this is an unknown-tool result.

### 4.2 The Python client is never installed, and would not ship

- `dsh_data_client.py:26-27` says the host preamble injects `dsh` and calls
  `install(dsh_module)`. The real preamble (`bridge.ts:1245-1262`) calls only
  `_dsh_mod._bind(...)`. `grep -n "install" packages/dsh-ipython/src/bridge.ts`
  returns nothing.
- `packages/dsh-daily-work/package.json` `files` is
  `["lib/**/*.js","lib/**/*.d.ts","cordis.patch.yml"]`, and `lib/` holds no `.py`.
  So the client is not in the published artifact set at all.

### 4.3 Per-stage verdict

| stage | reachable by product? | the break |
|---|---|---|
| `provider-acquisition` | **NO** | `webFetch` (`data-plane.ts:1010`) is reachable only via `routeDataRequest` (§4.1). |
| `native-acquisition` | **NO** | additionally, `DataPlane.fsCapture` does not accept `readChunks` (§4.4). |
| `transform` | **NO** | additionally, `webFetch` passes no `convert` to `provenanceFromFetch` (`data-plane.ts:1029-1037`), so even a working router could not reach it. |
| `retention` | **NO** | same `captureFile` chain as `native-acquisition`. |

### 4.4 Two additional breaks, measured, independent of §4.1

**(a) `DataPlane.fsCapture` cannot be made to acquire short.** Its input type is
`{path, mediaType?, observationId?, requestedRange?, claim?}` (`data-plane.ts:457-465`)
— there is no `readChunks` — and it forwards none (`data-plane.ts:490-533`). A
caller passing one anyway is silently IGNORED and the capture comes out FULL.
Measured in the DATA-09 native arm: the plane returned 4096 bytes,
`complete-within-request`, zero gaps.

This matters because `readChunks` is the ONLY way to make the acquired count fall
short of `stat`'s size: the default reader THROWS `artifact-integrity-error` when
the read ends early (`artifacts.ts:2490-2495`), and `requestedRange` deliberately
forces `shortBy = 0` (`artifacts.ts:2334-2336`). So the `native-acquisition`
producer is reachable only by calling `captureFile` (or `DataPlaneService.capture`)
directly — a test seam, not the product.

**(b) `webFetch` never passes a converter.** `provenanceFromFetch` computes a
transform gap only when `convert !== undefined && result.body.kind === 'html'`
(`web-provenance.ts:1182-1186`). `DataPlane.webFetch` passes four arguments and
stops (`data-plane.ts:1029-1037`), so `convert` is `undefined`. The transform
stage has no production path through the plane at all. Its only other
production-shaped caller is `HistoryPlaneService.recordFetch`
(`history-plugin.ts:154`), and `grep -rn "recordFetch" packages/ --include=*.ts |
grep -v '\.test\.ts' | grep -v '/lib/'` returns the DEFINITION only — no caller.

### 4.5 What IS reachable, stated so the negative is not over-read

The data plane's SERVICE is mounted: `data-plugin.ts` is a real bundle row
(`cordis.patch.yml:262-263`, `name: dsh-daily-work/data-host`), so `ctx.dailyData`
exists on a real boot and `DataPlaneService.open()` runs. `routeDataRequest` and
`DataPlane` are also re-exported from the package's public entry
(`data-plugin.ts:78-81`). What does not exist is any CALLER: no code path routes a
request in, and no client binds to it.

The row's own comment says this honestly at `cordis.patch.yml:231-234`: *"Its
intended model-facing caller is the M3 `python_exec`/`ipython` worker's
`dsh.data.*` namespace; the service is the stable seam that worker binds to, and
it is complete and probeable without it."* — the consumer is INTENDED, not
present.

## 5. What would close this (not fabricated here)

Both breaks are outside this slice's file ownership or would be a product change
larger than the case:

1. **R5's bridge** (`packages/dsh-ipython/src/bridge.ts`, `onCall`): add the
   single prefix branch `data-bridge.ts:36-56` specifies. That file is owned by
   another writer and is under active change, so it was NOT edited here.
2. **`dsh_data_client.py`**: must be added to `package.json` `files` (and copied
   to `lib/` by whatever build step), and `install(dsh_module)` must be appended
   to the preamble's statement list after `_bind`.
3. **`DataPlane.fsCapture`**: accept and forward `readChunks`, or provide some
   other host-side way to express a bounded acquisition.
4. **`DataPlane.webFetch`**: accept a converter (and its identity) and pass it as
   `provenanceFromFetch`'s 3rd argument.

Items 3 and 4 are small and are within this slice's files, but adding them would
be a PRODUCT change that no oracle in this case asks for, and doing it would not
make the stages reachable while §4.1 stands. They are recorded rather than
implemented, per V3 §7's "an honest BLOCKED beats a fabricated PASS".
