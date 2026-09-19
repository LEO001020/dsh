# V5-data — the DATA family (DATA-01 … DATA-12) at deployment identity `0a0996f3`

**Spec:** `qualification/specs/acceptance-spec.trusted-local-v1.json`, family `DATA`, 12 cases.
**Repo:** `D:\DSH\work\dsh-native-daily` @ branch `ipython-native`, HEAD `c3b9dba`.
**Pinned DSH (read-only):** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`.
**Deployment identity:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
— re-verified this round by `qualification/results/T1-spec/verify-identity.py`: **all 28 checks passed**.

Every claim below is labelled `[measured]` or `[read in source]`.

---

## 0. The build these cases ran against

`[measured]` Before any measurement the package was rebuilt, because the standing trap is
that every home installs via `link:` and resolves the **same** built `lib/`, never `src/`.

```
cd packages/dsh-daily-work
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json     # exit 0, no output
```

The rebuild was byte-identical to what was already on disk, so `lib/` was current rather
than stale. Recorded in `source-digests.txt`:

| file | sha256 |
|---|---|
| `lib/artifacts.js` | `5de9d97a218762eec5a5bcd5c22daf304b71bce93a92f0b15da3bfe62bdabffa` |
| `lib/data-service.js` | `4bbc68994f6391d620dc932cd3445a2489f5f68a6619aa6e72a9c02a6123253f` |
| `lib/observations.js` | `6aaff6e4fe66619a0282652e9bde5155d736867ac8d0c30d4ae845dc5dcb228c` |

`[measured]` The production sources are **byte-identical** to the ones T8 measured against
(`src/artifacts.ts` `f809bd7e…`, `src/observations.ts` `7ead0000…`, `src/data-service.ts`
`d029876f…`, `src/data-plane.test.ts` `a43d06d6…` all unchanged), so T8's measurements are
still valid at this identity and are cited rather than repeated.

`[measured]` The probe was run **twice**; the only difference between runs was an elapsed-ms
field inside a grace-GC skip reason (`within-grace (34ms < 60000ms)` vs `(40ms …)`). Every
verdict, count and digest was identical.

## 1. Instruments

| instrument | what it establishes | sha256 |
|---|---|---|
| `tests-data-plane.txt` | `data-plane.test.ts` at this HEAD: **exit 0, 68 tests passed** (1 file) | `6979b5548070e981b9244fcd47a64819e3bd818af907a90b4f19b28491961ee3` |
| `v5-data-probe.mjs` | the probe written for the gaps T8 did not cover | `e79f7f94a04f669684107a55b42a59f57cdb144e516e8e356ff458e71e6d7c2e` |
| `v5-data-probe.json` | its raw output (also mirrored as `v5-probe-run.txt`) | `42b9e9785c3a0e19e72fdac5176c211705a90c831ab3af860f94fb51b0ff2035` |
| `source-digests.txt` | build identity, source digests, pinned-checkout digests | `29ea1bc06f020f1ce6581033fbd30ee64b06a090569b25ea7d09c6d52d289685` |
| `T8-data/four-byte-classes.json` | the four byte classes on one 1 MiB artifact | (prior slice) |
| `T8-data/artifact-verification.json` | independent re-derivation, 11/11 | (prior slice) |
| `T8-data/falsify-run.txt` | the conflation falsification | (prior slice) |

Exact commands:

```sh
# the suite
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/data-plane.test.ts \
     --maxWorkers=1 --no-file-parallelism

# the probe
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/V5-data/v5-data-probe.mjs
```

---

## 2. Gate table

| case | assertion | exact command | measured result | verdict |
|---|---|---|---|---|
| **DATA-01** | a 100 KiB line spanning several pages is recovered byte-for-byte; no silent tail truncation at any intermediate cap; byte count and digest recorded | `vitest run src/data-plane.test.ts` → `DAT-01 [real] long line` (4 tests); probe → `g5_recordedDigests.DATA-01_longLineRecoveredByteForByte` | **102400 bytes, sha256 `8f73f6f3193b1c3f71ef6395278559fb9c01a8eac0731dfdc6e37667e7a310b2`, recovered sha256 identical, 2 pages walked, `TAILMARKER` present.** The intermediate cap is real and measured: the `read` tool's `READ_MAX_LINE_LENGTH=2000` yields 2034 chars, says `... (line truncated`, does **not** contain `TAILMARKER`, and is **not** a prefix of the line. The byte-range path recovers it | **PASS** |
| **DATA-02** | 512 pages / 32 MiB consumed correctly, model-visible projection ≤ 8 KiB, projection size recorded, **tier stated** | same run → `DAT-02 [real capture / real consumers]` (3 tests) | **33554432 bytes, 512 pages, digest equals source in all three consumers.** Projection: **399** B (in-process JS reducer), **429** B (real out-of-process CPython over a pipe), **437** B (real `ipython` tool over a real ipykernel). `artifactReads` 512, `sourceBytesRead` 0 during paging. Tier stated per test, never blurred. `cellReachedDataPlane false` is recorded — see §4 | **PASS** |
| **DATA-03** | UTF-8 / CRLF / JSONL split at every page boundary, including inside a multi-byte character: no corruption, no duplicate, no missing record; reassembly equals source | same run → `DAT-03 [real]` (5 tests); probe → `DATA-03_pageBoundarySweep` | Suite: 400 CRLF+JSONL records × 10 page sizes, and a 1..96 byte-size sweep over `漢`+`😀`+`é`. Probe: **5532 bytes, sha256 `f1e356753b62073fffd9728c428416ad4a199f838a21a5bf1dc2952c56efa0c4`, 120 records, 10 page sizes — every reassembly digest matches, every record count and set complete, no `U+FFFD`.** The honest boundary is stated separately: the *production* pager serves fixed-size byte windows, so an **individual** page need not be standalone-valid UTF-8 (measured: 4 of 5 pages at size 997); reassembly is byte-exact and `pageUtf8ByBytes` is the character-aligned alternative | **PASS** |
| **DATA-04** | a repeated cursor and a backwards cursor each raise `pagination-stalled` and the read terminates | same run → `DAT-04 [mock provider]` (5 tests) | Repeated cursor → `pagination-stalled` after **3** provider calls (two legitimate advances, then the repeat); backwards → after **2**; a not-exhausted page with no continuation → stalled. The message names the offsets (`resumed at offset 4`, `at or before the previous 8`). The counterweight passes: the **real** store walks 300 bytes in 5 pages to exhaustion, so the guard does not trip on progress. **No unbounded loop and no silent success.** The mock is the only mock in the file and is labelled as such | **PASS** |
| **DATA-05** | read page 1, modify the source, read page 2: page 2 still matches the captured hash or the read fails explicitly; two revisions never mixed; recorded hash stated | same run → `DAT-05 [real]` (3 tests); probe → `DATA-05_snapshotHashAfterSourceRewrite` | Recorded hash **`b778c9b54fd1178b186ed04d4e93ddfc6b655b1309458f9b902bf1a9222ed392`**; source rewritten (same path, same length) to **`42bb697d7220ece5a3829e41bc60ec3d7c661452653c41c444268cddccdc14da`**. Page 2 still reports **`b778c9b5…`**, the rejoined prefix is the *original* text, `rejoinedContainsRewrittenBytes false`, and a whole-artifact re-read hashes to **`b778c9b5…`**. A cursor bound to a different artifact is refused (`pagination-cursor-invalid`), and a cursor after a grant bump is refused (`pagination-scope-denied`) | **PASS** |
| **DATA-06** | physical IO for P pages is bounded well below P full-file scans; actual IO and index cost reported as measured numbers | same run → `DAT-06 [real]` (2 tests) | 4 MiB artifact, 8 pages read → **`artifactBytesRead 524288`**, `artifactReads 8`, `sourceBytesRead 0`. Index is **one** linear scan: `indexBytesScanned 4194304`, `indexBytesRead 4194304` (the counter R5 wired; before that it reported 0). Repeated-read control: **5 calls scanned 944445 bytes** (5 × 188889, i.e. a whole-file scan per call) against **20480 bytes** for 5 pages through the artifact path — a measured 46× difference, not a description | **PASS** |
| **DATA-07** | the canonical set is whole and readable programmatically; a backend raw cap is not mistaken for the whole set | same run → `DAT-07 [real ripgrep]` (2 tests) | Canonical **900** matches, all distinct, read back **through a real CPython process** (900 distinct, first 1, last 900). Renderer keeps **250 of 900**, `rendererTruncated true`, and its own text says it omitted the rest. Raw cap `20000000` **not** reached, so the canonical set is legitimately whole. Second test: when the cap **is** reached, the product **throws** `SearchError`/`SEARCH_RAW_OUTPUT_OVERFLOW` on the same call that succeeds with a generous cap. See §3 — **this is a mechanism deviation and it is recorded, not smoothed** | **PASS** (deviation recorded) |
| **DATA-08** | quota exhaustion and a mid-write failure are explicit, with stage; no unbounded inline expansion; no effect re-executed as a retry; store state recorded | same run → `DAT-08 [real]` (5 tests) | Quota **16384** against a **204800**-byte source → `completeness partial`, one **`retention`** gap with recovery `none`, reference state `missing`, **nothing published** (`referencedArtifacts` empty), projection **613 bytes** containing no content bytes. Orphan arm: object on disk but `state orphaned`, `resolveReference` refuses `artifact-orphaned`, reconcilable and grace-GC eligible. Missing arm: `artifact-integrity-error`, never `''`, tombstone `explicit-delete`. Checkpoint arm: `durable` but the gap records the failed checkpoint. `mayReExecuteAfterSaveFailure` is `false` for both observed and unobserved effects | **PASS** |
| **DATA-09** | losses at **six** named stages each appear in `acquisition.gaps` with a stage from the closed set plus a recovery | probe → `g1_gapAttribution` | **4 of the 6 stages have a real production producer and were driven**: `native-acquisition` (`artifacts.ts:1097`, 400-of-1000 → `partial` + gap + recovery `refetch`), `retention` (`artifacts.ts:1050` quota, and `:1154` orphan window), `provider-acquisition` (`web-provenance.ts:203`), `transform` (`web-provenance.ts:348` throw, `:364` empty). **2 stages have NO producer**: `transport` and `model-projection` are vocabulary members with **0 assignments in production source** (only the closed set, the type union, the verdict mapper and a test fixture). The stimulus demands all six losses. See §3 | **FAIL** |
| **DATA-10** | a refetch is a NEW observation with its own hash and time; the earlier hash and time stay retrievable; the earlier body is never overwritten or re-attributed | same run → `DATA-06 [real] a refetch is a NEW observation` (2 tests); probe → `g3_refetchIsANewObservation` | Artifact plane: a second capture under an already-committed id is **refused**; under a new id both coexist. Web plane: 2 observations, **two distinct ids**, `relation` `first`→`changed`, earlier hash **`sha256('version one')`**, earlier `acquiredAt 2026-09-20T00:00:00.000Z` and earlier `bytes 11` all survive intact; `earlierHashIsNotTheNewHash true`; no API returns "the current body for this url" (`Object.keys` is exactly `url,observations`) | **PASS** |
| **DATA-11** | replay a valid cursor against a different store or a different revision → refused and recorded | probe → `g4_cursorIsNotABearerToken` | Different **revision** → **refused** (`pagination-scope-denied`). Different **store** (same scope string, same artifact sha256, object present) → **NOT refused; it yielded 64 bytes.** The harm arm: an other-store holding different bytes under the same content address yielded bytes hashing to **`cc7321cc…`** while the descriptor names **`9076e7f7…`**. See §3 | **FAIL** |
| **DATA-12** | durable / orphaned / missing each resolve to their TRUE state from the store's own verdict; a missing object never returns an empty success; an orphan is reconcilable or grace-GC-eligible and never reported as delivered | same run → `DAT-08 [real]` orphan + missing + corrupt arms, crash-consistency block; probe → `g2_referenceStates` | All three states distinct in one store: **`durable`** (16 bytes, digest equals source), **`orphaned`** (object on disk, `resolveReference` refuses `artifact-orphaned`, reconcilable, `within-grace` skipped then collectable past grace, never delivered), **`missing`** (nothing published, log empty, `resolveReference` refuses `artifact-orphaned`, **no empty success**). Kept separate: committed-then-deleted → `artifact-integrity-error` + tombstone; object replaced in place → integrity error naming both hashes; object truncated → integrity error | **PASS** |

**Non-PASS: 2 FAIL.** Nothing above was made to pass by editing an oracle, skipping a case,
lowering a threshold, widening a permission, or recording a result that was not produced.

---

## 3. The three things a reader must not read as green

### 3a. DATA-09 — FAIL: two of the six gap stages have no producer

The oracle requires every one of the six named losses to appear in `acquisition.gaps` with a
stage from the closed set plus a recovery. The closed set is real and enforced
(`observations.ts:60-75`, zod enum at `:226`), and the verdict mapper handles all six
(`coverageVerdictOf`, `observations.ts:182-188`). But a vocabulary member with no producer
cannot appear in any real `acquisition.gaps`.

`[measured]` Driving every producer that exists:

| stage | real producer | measured gap |
|---|---|---|
| `provider-acquisition` | `acquisitionFromFetch` with a provider-truncated body | stage, recovery `refetch`, `partial` |
| `native-acquisition` | `captureFile` with a short reader | stage, recovery `refetch`, `partial`, reason names the missing 600 bytes |
| `transform` | `deriveMarkdown` — converter throws **and** converter yields no text | stage, recovery `none`, `derived` absent on both |
| `retention` | `captureFile` over quota, and the orphan window | stage, recovery `none`, `partial` |
| `transport` | **none** | **0 assignments in production source** |
| `model-projection` | **none** | **0 assignments in production source** |

`[read in source]` The search that establishes the absence, so a reader can repeat it: across
`artifacts.ts`, `observations.ts`, `data-service.ts` and `web-provenance.ts`, the string
`stage: 'transport'` and `stage: 'model-projection'` each occur **0** times. Their only
occurrences in the repo are the closed set, the type union, the verdict mapper, and one test
fixture in `data-plane.test.ts:2642,2655`.

**This is a real FAIL, not a documentation gap.** The spec's own rule is "A loss that is not
recorded as a gap is NOT PASS", and two of the six stimuli the case names cannot currently
produce a gap at all. A transport loss in the ipython plane is *counted*
(`OutputBuffer.dropped_frames`, rendered by `ipython-tool.ts:69`) but is **never wired into
`acquisition.gaps`** as a `transport` stage — so the two planes do not meet. A model-visible
projection smaller than the artifact is reported through `pagesConsumed`/`bytesConsumed` and
the verdict mapper, but no path *assigns* the `model-projection` stage either.

Related, and independently measured by another slice: `packages/dsh-ipython/src/v3-spec-gates.test.ts`
(IPY-15) already records that `note_dropped_frame` has **zero call sites**, so `droppedFrames`
is structurally always 0. That is the same absence seen from the other plane.

### 3b. DATA-11 — FAIL: a cursor replayed against a different store is NOT refused

The oracle's first arm is "replay a valid cursor against a different store". `[measured]`

```
sameArtifactSha256InBothStores   true
arm_differentStore               refused false   yieldedBytes 64     <- NOT refused
arm_differentScopeOnAnotherStore refused true    pagination-scope-denied
arm_differentRevision            refused true    pagination-scope-denied
control_ownStoreStillWorks       yieldedBytes 64, offset 64
```

`[read in source]` The mechanism is structural, not an accident of the probe. The cursor's
signature secret is derived from the **descriptor** only —
`cursorSecretOf` = `` `${id}:${sha256}:${ownerScope}:${grantRevision}` `` (`artifacts.ts:743-745`)
— and `PageCursor` (`artifacts.ts:537-544`) has fields `artifactSha256, representation,
position, schemaVersion, ownerScope, watermark`. **There is no store identity in either.** So
two stores that hold the same content address mint and accept the same cursors, and the scope
check that *does* fire is not a store check.

`[measured]` The harm is real and I isolated it from the cross-store question so it cannot be
read as a probe artifact. With the object corrupted **in the store the descriptor was minted
from**:

```
pages()            refused false  yielded 64 bytes hashing cc7321cc…   (descriptor names 9076e7f7…)
resolveReference() refused true   artifact-integrity-error
pagingAndResolveDisagree  true
```

`pages()` calls `store.openRange` directly (`artifacts.ts:715`); it never goes through
`resolveReference`, which is the function that hashes the bytes it read
(`artifacts.ts:1301-1308`). So the paging path serves bytes it never verified, and a store swap
is one way to reach that. The oracle's other arm (different **revision**) does hold, and the
control proves the cursor itself still works against its own store — so the refusal in the
revision arm is a real refusal, not a refusal of the cursor.

**Not fixed here.** `pages()` is shared production code; changing it changes what
`data-plane.test.ts` DAT-05/DAT-07 assert, and the repair is a design decision (bind the
cursor to a store identity, or route paging through the content check) with its own gates.
Recorded, not silently patched.

### 3c. DATA-07 — PASS, with a mechanism deviation that is recorded

The oracle's second clause reads "any backend raw cap is still marked `partial` with its
coverage recorded". `[measured]` When the cap **is** reached, the product does not return a
`partial`-marked descriptor at all: it **throws** `SearchError` / `SEARCH_RAW_OUTPUT_OVERFLOW`
(`search-core.ts:141-155`), and the same call succeeds when the cap is generous — so the
overflow is proven rather than assumed.

I mark this **PASS** because both substantive requirements of the oracle hold: the canonical
set is whole and readable through the programmatic path (900 matches, read by a real CPython
process), and the failure the oracle names last — "treating the rendered 250 as the whole set"
— is closed by a *hard refusal*, which is strictly safer than a partial marking, since a caller
receives nothing rather than a silently reduced set. **A reader who requires the literal
`partial` marking should read this row as a deviation, not as compliance.** The test file's own
author reaches the same conclusion in the source: "the honest claim is narrower than the
original test wanted".

---

## 4. What this slice does NOT prove

- **No `data.*` tool row exists**, so no cell can reach the data plane as a native call. The
  suite measures this rather than assuming it: `cellReachedDataPlane false`, and a cell's
  `import data` fails with `ModuleNotFoundError`. The consumption in DATA-02 is real (a real
  ipykernel, real artifact, real `ipython` tool) but the page walk is **host-driven**.
- **No composed-profile boot was run this round.** T8 recorded this as BLOCKED because
  `qualification/runners/verify-data-plane.mjs:58` writes to the **fixed** path
  `qualification/results/M4-data/profile-boot.json`, another agent's evidence file. I did not
  fix that runner: `M4-data/profile-boot.json` is currently **modified in the working tree**
  (`git status`), so re-running it would overwrite a peer's in-flight evidence. The in-process
  substitute (T8 S8: the same four counts through `DataPlaneService` over the real storage
  domain, 1048576/1048576/1048576/375, `reference.state durable`) stands, and it does **not**
  prove the `daily-data-plane` row resolves in a live boot.
- **`consumedBytes` counts bytes SERVED, not work done.** The CPython child's independent tally
  and digest corroborate that the bytes arrived intact; they do not prove the consumer used them.
- **No fix is claimed for §3a or §3b.** Both are measured and recorded; the shared production
  files were left unchanged.

## 5. The four byte classes — carried, not re-derived

`[measured]` T8's measurement is unchanged at this identity (same source digests, §0) and is the
evidence for the byte-class oracles in this family. On ONE 1 MiB artifact in one run:

| class | crosses | read from | value |
|---|---|---|---|
| `acquiredBytes` | source → host | `capture.io.sourceBytesRead` | 1,048,576 |
| `persistedBytes` | host → durable store | `store.stat(artifact).bytes` + `fs.statSync` | 1,048,576 |
| `consumedBytes` | store → consumer | page-walk sum; a real CPython child's tally agrees | 1,048,576 |
| `modelVisibleBytes` | host → model context | `JSON.stringify(projectForModel(...))` | **417** |

Non-conflation is proven both ways: the same artifact walked for one page reports persisted
1,048,576 vs consumed 65,536; and by falsification, a projection echoing `artifactBytes` into
`bytesConsumed` **would be caught** (it would report 1,048,576 for a 131,072-byte walk).
`[measured]` The artifact itself is real: 1,048,576 bytes, mode `0o444`, published by the
product's own `LocalArtifactStore.put`, re-derived by a fresh process 11/11, with `sha256sum`,
`certutil` and `wc -c` independently agreeing.

`[measured]` The `rawBytes` spread across prior slices (239,526 → 240,428 → 241,330) is **one
path character apart** at the measured slope of **+902 B per path character** (900 matches + 2),
with a ±2 B jitter from ripgrep's own `elapsed.nanos` summary field. It is a reproducibility
finding about quoting a raw byte count, not a numeric contradiction. **No numeric contradiction
was found with `P5-data/` or `R5-data/`.**

## 6. A structural conflict this slice ran into: the spec is BOTH an identity input and the evidence ledger

This is reported rather than worked around, because it affects every family filing evidence.

`[measured]` `python qualification/results/T1-spec/verify-identity.py` passed **all 28 checks**
before this slice filed anything, and passes **24 of 28** afterwards. The four that now fail are:

```
[FAIL] new spec digest on disk matches the pinned input
       pinned=e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7
       on_disk=dbe6ac01efa84675386c12cec6ee5ee3340d49e17c400389556e0c47f97a1405
[FAIL] no case is pre-marked PASS            offenders=['DATA-01'..'DATA-12']
[FAIL] no case ships with evidence           offenders=['DATA-01'..'DATA-12']
[FAIL] promotion spec_sha256 matches the new spec on disk
```

`[read in source]` The cause is a direct contradiction between two requirements the spec makes
of its own file:

1. `compatibility.lock.json → deployment.inputs.trusted_local_acceptance_spec_sha256` pins
   `e5b6a1d2…`, the digest of the spec **as authored** (all 109 cases `NOT_RUN`, all evidence
   lists empty). `verify-identity.py:172-180` checks the file on disk against that pin.
2. The spec's own `reading_notes.for_evidence_authors` says: "To file evidence, put a file under
   `qualification/results/<your-slice>/` and record its repo-relative path plus sha256 **on the
   case**." Recording evidence on a case necessarily edits the spec file.

So the first family to file any evidence changes the spec's digest, and checks 2 and 4 — which
are authoring-time anti-rigging checks (`verify-identity.py:19` calls a pre-marked PASS "a
rigged oracle") — cannot distinguish a legitimately filed verdict from a rigged one. They read
the file on disk, so they fire on the mandated workflow itself.

**Two facts that bound the severity, both `[measured]`:**

- The **deployment identity still recomputes**: `verify-identity.py` prints
  `computed=0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461 recorded=0a0996f3… (MATCH)`.
  The lock hashes its pinned input value, not the file, so filing evidence does **not** move the
  identity. Only the "file matches its authored digest" checks fail.
- The **independent spec verifier passes clean**:
  `python qualification/runners/verify-spec.py` reports
  `verify-spec: every recorded status agrees with its evidence.` with no problems, and the family
  summary shows `DATA  FAIL=2, PASS=10`.

**Not resolved here, deliberately.** The fix is a decision about the spec's own design, owned
above this slice: either (a) freeze the spec and keep the ledger in a separate file, (b) update
the lock's pinned digest after each filing round — which moves the deployment identity and would
invalidate every verdict filed under the old one, or (c) restrict checks 2 and 4 to the
git-committed authored revision. Choosing (b) unilaterally would invalidate other agents' work,
so the conflict is recorded and left to the owner of the spec.


`[measured]` T8's measurement is unchanged at this identity (same source digests, §0) and is the
evidence for the byte-class oracles in this family. On ONE 1 MiB artifact in one run:

| class | crosses | read from | value |
|---|---|---|---|
| `acquiredBytes` | source → host | `capture.io.sourceBytesRead` | 1,048,576 |
| `persistedBytes` | host → durable store | `store.stat(artifact).bytes` + `fs.statSync` | 1,048,576 |
| `consumedBytes` | store → consumer | page-walk sum; a real CPython child's tally agrees | 1,048,576 |
| `modelVisibleBytes` | host → model context | `JSON.stringify(projectForModel(...))` | **417** |

Non-conflation is proven both ways: the same artifact walked for one page reports persisted
1,048,576 vs consumed 65,536; and by falsification, a projection echoing `artifactBytes` into
`bytesConsumed` **would be caught** (it would report 1,048,576 for a 131,072-byte walk).
`[measured]` The artifact itself is real: 1,048,576 bytes, mode `0o444`, published by the
product's own `LocalArtifactStore.put`, re-derived by a fresh process 11/11, with `sha256sum`,
`certutil` and `wc -c` independently agreeing.

`[measured]` The `rawBytes` spread across prior slices (239,526 → 240,428 → 241,330) is **one
path character apart** at the measured slope of **+902 B per path character** (900 matches + 2),
with a ±2 B jitter from ripgrep's own `elapsed.nanos` summary field. It is a reproducibility
finding about quoting a raw byte count, not a numeric contradiction. **No numeric contradiction
was found with `P5-data/` or `R5-data/`.**
