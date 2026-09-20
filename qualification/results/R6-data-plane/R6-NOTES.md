=== R6: the `dsh.data` high-throughput programmatic data plane ===

SLICE: V3 §K1-K7. `packages/dsh-daily-work/src/data-plane.ts`, `data-bridge.ts`,
`data-concurrency.ts`, `projection-manifest.ts`, `dsh_data_client.py`, plus edits
to `data-service.ts`, `data-plugin.ts`, `cordis.patch.yml`.

WORKTREE / IDENTITY. Every number below was measured inside
`D:\DSH\work\wt-r6` on branch `wt/r6`, against the worktree's OWN built packages.
Per G-SEAM-60 the provisioning script proved each extension package resolves to
this tree; the tests below mount `LocalFileSystem`, `Storage`,
`storage-json`, `storage-domain` and `dsh-attachment-local` through this
worktree's junction farm. Source digests are in `source-digests.txt`.

---------------------------------------------------------------------------
1. THE INVARIANT, MEASURED ON ONE 32 MiB SOURCE
---------------------------------------------------------------------------

Test: `R6-K7 [real] 32 MiB stress`, `src/data-r6.test.ts`.

Stimulus: one generated 32 MiB file whose FIRST 128 KiB is a single line of
position-varying bytes (so a positional clip is detectable) followed by filler.
That covers both K7 stimuli (>= 32 MiB source, > 100 KiB single line) in one file.

Measured, from the test's own stdout:

  acquiredBytes        33554432
  persistedBytes       33554432
  pythonConsumedBytes  33554432
  modelVisibleBytes         409
  ratio                   82040   (consumed / model-visible)
  pages                     512
  artifactBytesRead    33554432
  artifactReads            512
  quadraticWouldBe   17179869184   (512 x 32 MiB, i.e. the failure not observed)
  digestVerified          true

WHAT EACH COUNT IS, AND WHICH SOURCE PRODUCED IT:

  acquired   `capture.io.sourceBytesRead` -- bytes the SOURCE read cost.
  persisted  the STORE's own `stat` of the published object, not the descriptor's
             field copied forward. This matters: comparing a descriptor field
             against itself proves nothing.
  consumed   the walk's per-page sum, hashed as it goes.
  visible    `Buffer.byteLength(JSON.stringify(projection))` -- the only thing a
             model sees about the walk.

All four agree at 33554432 for a complete capture, which is what makes them
COMPARABLE rather than four unrelated numbers. The ratio is 82040:1.

NO QUADRATIC PER-PAGE COST, MEASURED NOT ARGUED. `artifactBytesRead` equals
`consumedBytes` exactly (amplification 1.0), and `sourceBytesRead` is 0 during
paging. A per-page full rescan would have cost 512 x 32 MiB = 17179869184 bytes.
A separate test (`R6-K7 paging is O(pages)`) reports the same for a 64-page
4 MiB walk and asserts `amplification < pages`.

The model-visible bound is asserted `<= 8 KiB` and measured at 409 bytes.

---------------------------------------------------------------------------
2. WHAT WAS BUILT, AND THE ONE DESIGN DECISION THAT IS LOAD-BEARING
---------------------------------------------------------------------------

`dsh.data` requests stay BOUND to a live cell (attribution/cancellation) but do
NOT go through `ctx.tools.execute`. They call PUBLIC DSH capability seams
directly: `ctx.fs`, `ctx.sessionQuery`, `ctx.web`, `ctx.attachments`.

WHY, and this is the audit's correction rather than a preference:
`ctx.tools.execute()` runs one complete ToolRuntime pipeline, and Native
AgentLoop/PTC coordinate their ORDERED pre/post stages through a module-local
scheduler Symbol (`TOOL_RUNTIME_SCHEDULER`) that is NOT a public downstream seam.
Issuing several `execute()` calls concurrently therefore buys NO scheduling
parity -- it runs several pipelines whose ordered stages can interleave. Bulk-data
throughput needs capability-level READ concurrency, which is a different
primitive. The split:

  `dsh.call`   = exact ToolRuntime semantics, SERIAL     (writer R5 owns)
  `dsh.data.*` = bounded-concurrency read plane          (this slice)

THE PYTHON NAMESPACE SEAM FOR R5 (the integration contract). `data-bridge.ts`
exports it as three symbols and one reserved prefix:

  DATA_TOOL_PREFIX = 'data:'
  isDataRequest(tool)                    -- a single prefix test
  dataCallerFromEnclosing(authority)     -- the ONLY DataCaller constructor
  routeDataRequest(plane, caller, tool, args) -> {ok, value} | {ok:false, error}

R5's change is ONE BRANCH in the bridge's per-call handler: if
`isDataRequest(call.tool)`, call `routeDataRequest` and return its outcome;
otherwise dispatch to `ctx.tools.execute` exactly as today. A COLON is used
rather than a dot because a colon is not valid in a DSH tool name, so the prefix
is un-collidable by construction rather than by convention.

The Python side is `src/dsh_data_client.py`, installed by
`install(dsh_module)`, which reads the channel from
`dsh_module._channel.call_async`. It raises `DATA_NO_CHANNEL` at INSTALL time if
that attribute is absent, so a mis-wired bridge is a loud startup error rather
than a namespace whose every method fails later.

The Python surface is deliberately five namespaces and nothing more:
`fs`, `history`, `web`, `artifacts`, `projection`. A test asserts the list from
the PYTHON side and asserts that every method the Python client invokes is in the
router's `DATA_METHODS`, so the two cannot drift silently.

AUTHORITY IS HOST-OWNED. `dataCallerFromEnclosing` reads every field from the
live enclosing execution. No plane method reads an Agent, Session, workspace or
scope from a request payload. A test sends a payload asserting
`captured: {sha256, bytes, artifact}` and asserts the refusal names the forged
path (`observation-authority-forged`).

---------------------------------------------------------------------------
3. K1 -- FILESYSTEM
---------------------------------------------------------------------------

Capture goes THROUGH `ctx.fs` (`resolve` -> `stat` -> bounded `readByteRange`
windows), so the backend's own authority applies and there is no host-path
bypass. The model-facing `read` tool is deliberately NOT the primitive: its
windowing is bounded on purpose.

The FsTarget identity basis is recorded as three SEPARATE fields
(`targetKey` / `version` / `stat`), read BEFORE the capture so a concurrent
writer is visible rather than invisible.

MEASURED DEFECT FOUND AND FIXED IN THIS SLICE -- `requestedRange` did not bound
the read. It only annotated the coverage claim, so a `{offset:1024, length:512}`
request over a 4096-byte file published a 4096-byte artifact: the object was not
the requested scope. Fixed by supplying a `readChunks` override that reads exactly
the requested window through the same `readByteRange` primitive. The test now
asserts the published object is 512 bytes with `claimScope: 'request'` and
`complete-within-request` (a narrowed request is legitimately fewer bytes than the
file holds, so it must NOT be reported as a short acquisition).

---------------------------------------------------------------------------
4. K2 -- HISTORY
---------------------------------------------------------------------------

One `ctx.sessionQuery.observeSession(...)` lease is taken per paging operation and
every subsequent page filters the SAME immutable cut in memory. The cursor binds
all five things K2 names: session id, observation watermark (maxSeq), persistence
revision when the observation exposes one, canonical query/filter representation,
and position. A cursor replayed with a different query representation is REFUSED
(`HISTORY_WATERMARK_SUPERSEDED`) rather than re-based.

This is the design the K7 no-quadratic requirement exists to protect:
`ctx.sessionQuery.readEvent` goes through `SessionCorpus.load`, which for a
persisted session reads the COMPLETE log on every call, so a search that re-read
the log per page would be O(pages x log).

`fullLogMaterializations` is reported per page and is 1 for the whole traversal.

NOT PROVEN: no test in this slice drives a REAL populated session through the
plane, because the shipped profile configures session-query with `openAt: 'never'`
and this mount has no session-query service. The measured behaviour here is the
plane's own DEPLOYMENT-fact refusal (`DATA_NO_CAPABILITY`), which is asserted to
name the deployment as the cause rather than return an empty history. The paging
and cursor logic is exercised structurally but not against a real log.

---------------------------------------------------------------------------
5. K3 -- WEB (no live request was made)
---------------------------------------------------------------------------

NO OUTBOUND SEARCH WAS DRIVEN. `G-SEAM-52` is OPEN: the ported provider is
MOUNTED but NOT SELECTED, so `ctx.web.search()` reaches the DeepSeek backend and
a call would place a REAL request against a real API. No case in the spec
authorizes that, so the web path is exercised through STUB PROVIDERS registered
on a REAL `ctx.web` runtime (`WebRuntime` mounted, provider registered through
`registerSearchProvider` / `registerFetchProvider`). The mis-selection is
reported, not provoked.

Measured through that seam:
  - a provider-capped fetch -> `partial`, gap stage `provider-acquisition`,
    recovery `refetch` (never `page`: the missing bytes are in no local object).
  - a complete fetch -> `complete-within-request` with no gaps, so the partial
    marking is not vacuous.
  - a REFETCH creates a NEW observation id and digest while the earlier record's
    id, digest, time and `partial` verdict all survive unchanged. Old partial
    evidence is never mutated into "full".
  - a search is recorded as `ranked-top-k-of-provider-result-set` with
    `mayBeMore: 'unknown'` when the provider exposes no cursor. A short list is
    never recorded as exhaustion.
  - an empty query is REFUSED as a caller error, never reported as an empty
    result set.

The selected provider id is RECORDED on every outcome, because "which provider
answered" is exactly the fact G-SEAM-52 shows can differ from the configuration.

MEASURED DEFECT FOUND AND FIXED IN THIS SLICE -- the provenance record's own
observation id collides within one millisecond. `web-provenance.ts:1047` derives
it as `fetch:<provider>:<sha256(url + acquiredAt).slice(0,16)>`, and `acquiredAt`
is an ISO string at MILLISECOND resolution. Measured: a truncated fetch and its
complete refetch both reported `fetch:r6-stub-fetch:b3d064c960937f6d`, so the
second observation claimed the first one's identity -- the "old observation
silently acquires the new bytes" failure arriving through the id rather than
through a reference row. The plane now mints its own id from the content digest
plus a host-monotone sequence. `web-provenance.ts` is NOT edited from this slice;
the derivation is recorded as an adjacent finding.

---------------------------------------------------------------------------
6. K4 -- ATTACHMENTS
---------------------------------------------------------------------------

`saveFileStream` / `readFileStream` are used through `ctx.attachments`. The
source iterable is a generator over the IMMUTABLE artifact's byte ranges in
bounded windows, so the provider is never handed the complete sequence in memory
and the bytes stored are the captured revision rather than a re-read of the live
source.

MEASURED DEFECT FOUND AND FIXED IN THIS SLICE -- the id comparison refused every
successful save. The attachment store's id is `sha256:<digest>`
(`attachment-local/src/file-store.ts:97,125`), not a bare digest. Comparing it
against the descriptor's bare digest fails for EVERY correct save, and a check
that refuses correct data is worse than no check. Both sides are now normalized;
the cross-store comparison is preserved and is a real integrity check.

---------------------------------------------------------------------------
7. K5/K6 -- PROJECTION IS A SEPARATE FACT (D2)
---------------------------------------------------------------------------

`projection-manifest.ts` is a new file and a new type. It does NOT add a stage to
`OBSERVATION_GAP_STAGES` and does NOT touch `acquisition.gaps`; R8 owns that
taxonomy and this slice reports the boundary rather than editing it.

The manifest carries source refs, selector name/version/digest, selected counts,
omitted counts WHEN KNOWABLE, the emitted digest and byte length, and
recoverability refs. Two refusals make it honest:
  - omitted bytes with NO recoverability ref is REFUSED, because that combination
    is a LOSS rather than a projection, and filing it as a projection is the
    conflation D2 exists to prevent;
  - a negative or fractional count is REFUSED rather than recorded, and `undefined`
    means UNKNOWABLE -- never zero, which would claim exhaustiveness.
`omittedIsExact` is DERIVED from the mode, so a caller cannot claim exactness its
mode does not support: only `exhaustive` makes an omission a measurement.

MEASURED: a 32 MiB capture with a 409-byte projection leaves the descriptor at
`complete-within-request` with ZERO gaps, and the manifest records
`omittedBytes = 33554432 - 409` with `omittedIsExact: false`. The acquisition is
untouched, which is the whole point.

---------------------------------------------------------------------------
8. K3 -- BOUNDED PARALLELISM (HOST-OWNED)
---------------------------------------------------------------------------

`DataReadLimiter` in `data-concurrency.ts`. Default 4, which is BELOW every
shipped parallelism default in this repository (registry
`maxParallelSubCalls` = 10; `native-call.ts` = 8), so the read plane can never be
the component that saturates a provider. A test asserts
`DEFAULT_DATA_READ_CONCURRENCY < 8`.

MEASURED: 8 tasks through a limiter of 2 report `peakInFlight === 2`, not 8. A
rejected body releases its slot (`inFlight` returns to 0), because a leak here
would silently shrink the plane's capacity for the process lifetime and only
appear under load. A non-positive or fractional bound is REFUSED.

The bound is a CONSTRUCTION input, configured in the bundle patch as
`readConcurrency: 4`. It is not reachable from a request, so a model cannot widen
its own fan-out.

The limiter is SHARED by every cell on purpose: a per-cell limiter would multiply
the bound by the number of live cells, which is the unbounded fan-out it exists
to prevent.

---------------------------------------------------------------------------
9. K7 -- FAULT ARMS
---------------------------------------------------------------------------

  - QUOTA / ENOSPC: a capture over the store's own quota returns a `partial`
    observation with a `retention` gap, recovery `none`, and NO artifact. No
    inline fallback: the outcome is a small honest answer, and the test asserts
    the payload bytes do not appear in the serialized outcome.
  - CORRUPT object: overwriting the stored object in place at the SAME length is
    refused with `artifact-integrity-error`, and the message names BOTH hashes.
  - MISSING object: refused with `artifact-integrity-error` naming absence, never
    an empty success.
  - ORPHAN (published, unreferenced): refused with `artifact-orphaned`, never
    delivered.
  - CANCELLED cell: every entry point refuses with `DATA_CALLER_ABORTED` rather
    than running with no owner.
  - A cell that names a directory or a missing path gets a NAMED error, never an
    empty capture.

---------------------------------------------------------------------------
10. THE ARTIFACT-ROOT DEFECT (G-R5-04 / G-SEAM-63) -- FIXED
---------------------------------------------------------------------------

FINDING, re-verified before fixing: `defaultArtifactRoot` read a `root` member
the mounted `storageDomain` does not have. `Domain`
(`storage-domain/src/domain.ts:97-119`) declares exactly `name`, `global`,
`table()` and `close()`; no file in `storage-domain/src` mentions a root. So the
guard could never be true and the store ALWAYS resolved the RELATIVE
`data-artifacts` against the process cwd.

WHY "READ THE BACKEND'S ROOT" WAS NOT AVAILABLE. `StorageBackend`
(`storage/src/backend.ts:17-27`) declares only `kv?` and `close()`;
`BackendRegistry.get(name)` returns that interface; and `JsonStorageBackend`'s
root is `constructor(private readonly root: string)`
(`storage-json/src/index.ts:46`) -- a TypeScript `private`. Reaching it needs an
upstream change or a cast reading a private field, and a cast that reads a field
the type says does not exist is the same defect class being fixed.

THE FIX, in precedence order:
  1. An explicitly configured `artifactRoot` wins and must be ABSOLUTE; a
     relative configured root is REFUSED with a named error, because it would
     reproduce the cwd accident with an extra step.
  2. Otherwise derive from `dshHomePath`, published by `app-boot` with
     `ctx.provide('dshHomePath', dshHomePath)` at
     `packages/boot/app-boot/src/index.ts:940`. This is the SHIPPED convention:
     the base bundle already uses it for `sessions` and `storages`
     (`bundle/base/cordis.patch.yml:120,158`). It resolves against `$DSH_HOME`,
     never the cwd.
  3. Only when neither exists (an in-process mount with no `app-boot`) does the
     relative fallback run, and it is RECORDED: `service.artifactRootFallback`
     names it and the host log gets a warning quoting `process.cwd()`.

The bundle patch now sets `artifactRoot: !!js dshHomePath('data-artifacts')` and
the stale comment claiming the domain-derived root was the normal path is
DELETED.

FOUR TESTS PIN IT: helper-present resolves under the home and the fallback record
stays `undefined`; helper-absent takes the relative path and RECORDS it; a
relative configured root is refused; an absolute configured root is used verbatim.
The old reproduction (the relative fallback) is preserved as an assertion in the
fallback test, so the before/after pair is on disk.

NOT CLAIMED: the fallback is NOT gone. An in-process mount still takes it. What
changed is that it is observable rather than silent.

---------------------------------------------------------------------------
11. EXACT COMMANDS AND RESULTS
---------------------------------------------------------------------------

  cd packages/dsh-daily-work
  node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
    -> exit 0                                        (qualification/results/R6-data-plane/tsc.txt)

  node ./node_modules/vitest/vitest.mjs run src/data-r6.test.ts
    -> 38 passed (38)                                 (tests-r6-data-plane.txt)

  node ./node_modules/vitest/vitest.mjs run src/data-plane.test.ts
    -> 71 passed (71)   [after linking the missing `tsx`/`esbuild` dev deps]

---------------------------------------------------------------------------
12. PROVISIONING GAP ENCOUNTERED (attributable, not a regression)
---------------------------------------------------------------------------

`src/data-plane.test.ts`'s crash-consistency test spawns a child through `tsx`,
which this worktree's junction farm did not link (the worktree predates
`link-all-dsh.ps1` commit `51d80bd`). Measured: `Cannot find package 'tsx'`, then
after linking `tsx`, `Cannot find package 'esbuild'` from inside tsx's own dist.
Both were linked into THIS worktree's `node_modules` from the main tree's `.pnpm`
store. One junction was briefly created inside the shared pinned checkout
(`D:\DSH\src\dsh-src`) while diagnosing, and it was REMOVED immediately; the
final state has both links inside `D:\DSH\work\wt-r6` only.

No file outside `D:\DSH\work\wt-r6` was written by this slice.

---------------------------------------------------------------------------
13. WHAT IS NOT PROVEN
---------------------------------------------------------------------------

  - No cell has called `dsh.data` through the bridge. The router and the Python
    client are each tested, and the Python client is tested under a REAL CPython
    against a stand-in channel, but the one-branch wiring in
    `packages/dsh-ipython` is R5's package and is documented as a contract here
    rather than implemented.
  - No history page was read from a REAL populated session log (see §4).
  - No live web request was made, by design (see §5).
  - The limiter's default of 4 is a CONSERVATIVE CHOICE, not a benchmarked
    optimum. V3 §K3 says "benchmark before raising it"; no benchmark was run.
  - The concurrency bound is enforced in-process. It bounds concurrent reads
    issued by THIS host; it does not bound anything a second process does.
