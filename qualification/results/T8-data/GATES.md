# T8-data — the four byte-count classes, measured separately

**Repo:** `D:\DSH\work\dsh-native-daily` @ branch `ipython-native`
**Pinned DSH (read-only):** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0, CPython 3.14.3, ripgrep 15.0.0 (rev `3a612f88b8`)
**Evidence:** `four-byte-classes.json`, `artifact-verification.json`, `falsify-conflation.json`,
`raw-bytes-slope.json`, `provenance.txt`, `source-digests.txt`, `tests-data-plane.txt`, `tsc.txt`,
plus the run logs `probe-run.txt` / `verify-run.txt` / `falsify-run.txt` / `raw-bytes-slope-run.txt`,
the four probe scripts, and the persisted object under `artifacts/`.

---

## 1. The four classes, stated explicitly

The sources name them. `src/data-plane.test.ts`, the `DATA-04/12` block, says:

> "The four are read from four different sources: the capture's `sourceBytesRead` counter,
> the store's `bytes`, the page-walk's `bytesConsumed`, and the serialized projection."

| # | class | what crosses | read from | measured on the artifact |
|---|---|---|---|---|
| 1 | **acquiredBytes** | the SOURCE boundary — what the acquisition actually pulled | `capture.io.sourceBytesRead` (`artifacts.ts:1030`) | **1,048,576** |
| 2 | **persistedBytes** | the DURABILITY boundary — what the object store holds | `store.stat(artifact).bytes` (`artifacts.ts:321`) | **1,048,576** |
| 3 | **consumedBytes** | the ARTIFACT boundary — what a consumer read back out | Σ `page.bytes.byteLength` over a real walk | **1,048,576** |
| 4 | **modelVisibleBytes** | the MODEL boundary — what enters the context | `Buffer.byteLength(JSON.stringify(projectForModel(…)))` | **417** |

Every one of the four is measured on the SAME artifact, in ONE run, from its own source.
`probe-run.txt` / `four-byte-classes.json` scenario `S1_full_walk`.

**Two more numbers are NOT among the four, and are reported separately so they cannot be
mistaken for them:**

- the **source file's own size** (`fs.stat` at capture start) — equal to `acquired` on a
  clean whole-file capture, but it is what `acquired` is CHECKED AGAINST, not a fifth class
  that can be read out of the record;
- the **tool-output boundary** of a `grep` (raw stdout / canonical set / rendered rows /
  projection) — measured in scenario `S7`, four *different* numbers again. The brief's own
  example wording ("raw tool output vs what the model sees vs what is persisted vs what the
  transcript stores") describes that boundary, not this one. The Session transcript's byte
  count is the history plane's (`history-plane.ts` `canonicalEventBytes`): **read in source,
  not measured here** — see `four-byte-classes.json.supplementary.transcriptBoundary`.

---

## 2. Gate table

| gate | assertion | measurement command | verdict |
|---|---|---|---|
| **T8-01** | The four classes are named from the sources, each read from its OWN source, and all four measured on one artifact | `cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/results/T8-data/t8-four-byte-classes.mjs` → `S1_full_walk` | **PASS** — 1,048,576 / 1,048,576 / 1,048,576 / 417 |
| **T8-02** | `persistedBytes` is the artifact's own byte count, not a number the producing process reported about its own variable | `… t8-verify-artifact.mjs` → V-02, V-03, V-04, V-05 | **PASS** — `fs.statSync` 1,048,576; streamed sha256 over 16×64 KiB windows equals the artifact digest; a COLD product store reproduces both |
| **T8-03** | Two classes DIFFER on the same artifact and both are reported correctly (non-conflation) | `… t8-four-byte-classes.mjs` → `S2_partial_walk`; `… t8-falsify-conflation.mjs` | **PASS** — persisted 1,048,576 vs consumed 65,536 in `S2`; and the projection reports `artifactBytes 1048576` alongside `bytesConsumed 131072` in the falsification probe |
| **T8-04** | A CONFLATED implementation would be CAUGHT, not silently accepted | `… t8-falsify-conflation.mjs` → `falsification.wouldAConflatedProjectionBeCaught` | **PASS** — `true`; a projection echoing `artifactBytes` into `bytesConsumed` would report 1,048,576 for a 131,072-byte walk, and the product's two fields differ |
| **T8-05** | `acquiredBytes` reports what was acquired, not the file's size | `… t8-four-byte-classes.mjs` → `S3_short_acquisition` | **PASS** — a 1000-byte file whose reader stops at 400 reports acquired 400, `partial`, a `native-acquisition` gap naming the missing 600, recovery `refetch` |
| **T8-06** | `acquiredBytes` and `persistedBytes` diverge when the retention layer refuses, and the record says so | `… t8-four-byte-classes.mjs` → `S4_quota_refusal` | **PASS** — acquired 65,536 while the store published NOTHING (`store.stat` on the placeholder ref is refused; `reference.state === 'missing'`; the log holds no artifact); `partial` + a `retention` gap, recovery `none` |
| **T8-07** | The four counts hold through the PRODUCTION SERVICE, not only the library | `… t8-four-byte-classes.mjs` → `S8_production_service` | **PASS** — `DataPlaneService` over the real storage domain: 1,048,576 / 1,048,576 / 1,048,576 / 375, `reference.state === 'durable'`, all 8 composed methods present |
| **T8-08** | The observation artifact is a REAL object on disk with its own byte accounting | `… t8-verify-artifact.mjs` → verdict; then `sha256sum` + `wc -c` + `certutil -hashfile` on the object | **PASS** — 1,048,576 bytes, sha256 `73f1a5c6…5f8ba0`, mode `0o444`; three OS-level tools agree with the recorded digest |
| **T8-09** | The artifact's byte accounting is reproducible from a FRESH process, and its content is traceable to its stated inputs | `… t8-verify-artifact.mjs` → V-01 … V-11 | **PASS** — 11/11 checks, `failures: []` |
| **T8-10** | The `data-plane.test.ts` suite still passes at this HEAD | `cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/data-plane.test.ts --maxWorkers=2 --no-file-parallelism` | **PASS** — exit 0, 1 file, **68 tests passed** |
| **T8-11** | The typecheck baseline is kept | `cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work && node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json --noEmit` | **PASS** — exit 0, no output |
| **T8-12** | A `requestedRange` narrows what is RECORDED, not what is read | `… t8-four-byte-classes.mjs` → `S5_requested_range_not_honoured` | **FAIL** — see §3a |
| **T8-13** | The acquired-vs-persisted shortfall guard cannot be bypassed | `… t8-four-byte-classes.mjs` → `S6_shortfall_guard_bypass` | **FAIL** — see §3b |
| **T8-14** | A raw tool-output byte count is reproducible from the evidence that records it | `… t8-four-byte-classes.mjs` → `S7_tool_output_boundary`; `… t8-raw-bytes-slope.mjs` | **FAIL (claim discipline)** — see §3c |
| **T8-15** | Production reachability through a real composed-profile boot (the `daily-data-plane` row resolving in a live host) | not run this round — `qualification/runners/verify-data-plane.mjs` boots a real host and writes to the FIXED path `qualification/results/M4-data/profile-boot.json`, which is another agent's evidence file | **BLOCKED** — see §4 |

Non-PASS: 3 FAIL, 1 BLOCKED. Nothing above was made to pass by weakening an oracle,
skipping a test, lowering a threshold, or widening a permission.

---

## 3. The three FAILs, stated precisely

### 3a. T8-12 — `requestedRange` is recorded but never honoured

`captureFile` accepts `requestedRange` (`artifacts.ts:936`) and writes it into
`coverage` (`artifacts.ts:1126`), but **nothing narrows the read by it**:
`defaultReadChunks` (`artifacts.ts:1235-1247`) always streams from offset 0 to EOF.

Measured (`S5_requested_range_not_honoured`): a caller asks for 64 KiB of a 1 MiB file.

```
requestedRange      { offset: 0, length: 65536 }
acquiredBytes       1048576      <- the WHOLE file
persistedBytes      1048576      <- the WHOLE file
coverageRecorded    { receivedBytes: 1048576, claimScope: "request",
                      requestedRange: { offset: 0, length: 65536 } }
completeness        complete-within-request
rangeWasHonoured    false
```

The record therefore asserts a request scope it did not apply. `coverage.claimScope` is
`"request"` while the object holds 16× the requested range — the recorded scope and the
acquired bytes are two different facts that the record presents as one.

### 3b. T8-13 — the shortfall guard is bypassable by naming a range

`artifacts.ts:1093` disables the acquired-vs-persisted check whenever `requestedRange` is
present:

```js
const shortBy = sourceBytesAtStart !== undefined && request.requestedRange === undefined
  ? sourceBytesAtStart - published.bytes
  : 0
```

Because the read is not actually narrowed (§3a), a short read that is correctly `partial`
WITHOUT a range becomes `complete-within-request` WITH one. Same bytes, two verdicts:

| scenario | file | read yields | `requestedRange` | completeness | gaps | `isDeliverableAsComplete` |
|---|---|---|---|---|---|---|
| `S3_short_acquisition` | 1000 B | 400 B | absent | `partial` | 1 × `native-acquisition` | false |
| `S6_shortfall_guard_bypass` | 1000 B | 400 B | `{offset: 0}` | **`complete-within-request`** | **0** | **true** |

This is the acquired-vs-persisted collapse the comment at `artifacts.ts:1088` says "the whole
data plane exists to prevent": the two numbers are both present and the guard that compares
them is off. **Not fixed here** — see §5.

### 3c. T8-14 — a raw tool-output byte count is not reproducible

`S7` measures one `grep` over 900 matches and gets four different numbers at that boundary
(241,330 raw / 900 canonical, 123,083 canonical-JSON / 250 rendered rows, 10,457 rendered /
370 projected). But the **raw** figure is not reproducible, on **two independent axes**:

**(i) It depends on the path.** ripgrep's `--json` stdout embeds the absolute path in every
match event, so identical content in differently-named directories yields different raw bytes.
Five path lengths, 5 samples each (`raw-bytes-slope.json`):

| path chars | mode raw bytes | spread over 5 samples |
|---|---|---|
| 64 | 245,840 | 0 |
| 66 | 247,644 | 0 |
| 68 | 249,448 | 2 |
| 70 | 251,252 | 2 |
| 72 | 253,056 | 0 |

That is **exactly +902 bytes per path character** over the 8-character span (7,216 / 8 = 902),
which is `900 matches + 2` — the path is emitted once per match event. The coefficient is
exact, not approximate.

**(ii) It depends on the SEARCH DURATION, on a fixed path.** Ten consecutive identical
commands over one file gave `distinctRawBytes: [241328, 241330]` while `bytes_printed` was a
single value, 240740. The slope probe reproduced the same 2-byte spread at two of its five
path lengths (68 and 70). The cause is ripgrep's own trailing `summary` event, which carries
`elapsed.human` / `elapsed.nanos`: a sub-millisecond search emits a 6-digit `nanos` value
where a slower one emits 7, so the summary event is 273 or 274 bytes
(`distinctSummaryEventBytes: [273, 274]`). The match data itself is stable across repeats at
a fixed length (`bytesPrintedStableAcrossRepeats: true`); it rises with path length, as it
must, because it contains the path.

Together these explain the four different "raw bytes" values already in this repo's evidence
for the *same* 900-match stimulus:

| source | raw bytes | path chars | why |
|---|---|---|---|
| `P5-data/baseline-tests.txt` (`[DAT-07]`) | 239,526 | 58 (derived) | temp dir `m4-dat07-…` |
| `R5-data/raw-cap-measurement.json` | 240,428 | 59 | temp dir `r5-rawcap-HC2IiA` (50 chars) + `\many.txt` |
| this probe `S7` | 241,330 | 60 | temp dir `t8-s7-grep-…` + `\many.txt` |

These three are **exactly consistent with the measured slope**, one path character apart each:
239,526 + 902 = 240,428, and 240,428 + 902 = 241,330. The R5 path length is verifiable from
its own JSON (`raw-cap-measurement.json.root` is 50 characters, and the probe writes
`<root>/many.txt`), and the P5 value follows by the same step. The model accounts for every
value; only the path differs. The jitter (ii) is a separate ±2-byte effect on top.

**None of these contradict each other and none is wrong** — they are the same quantity
measured over different paths, and two of them differ from each other only by the timing
field. The FAIL is a claim-discipline one: a raw tool-output byte count quoted without its
path — and without a tolerance for the timing field — is not a reproducible measurement. All
values are far below the 20,000,000 cap, so DAT-07's "the canonical set is whole because the
cap was not hit" conclusion is unaffected.

---

## 4. The BLOCKED gate

**T8-15 — production reachability.** The strongest form of this claim is the one already
recorded at `qualification/results/M4-data/profile-boot.json`: a real composed-profile boot in
which `ctx.dailyData` resolves, the service captures a real file through the profile's own
`ctx.fs`, and the reference reaches `durable`. I did **not** re-run it this round:

- `qualification/runners/verify-data-plane.mjs:58` writes to the **fixed** path
  `qualification/results/M4-data/profile-boot.json` — another agent's evidence file. The
  shared boot harness's own header warns that a fixed output path is "a SHARED MUTABLE
  RESOURCE: two agents running it cannot tell whose result they hold", and that "produced a
  false PASS earlier in this project".
- Booting a full host is also the heaviest thing available, and the standing CPU constraints
  for this wave say one test file at a time and no load loops.

I could not make this measurement without either overwriting another agent's evidence or
adding a second probe under a path I do not own, so it is **BLOCKED, not PASS**. The
substitute actually run is T8-07: the same four counts through `DataPlaneService` over the
real storage domain, in-process. That proves the service composes and measures; it does
**not** prove the `daily-data-plane` row resolves in a live boot. The prior evidence for that
is unchanged and remains the reference.

---

## 5. What is NOT fixed, and why

The two defects in §3a/§3b are in `packages/dsh-daily-work/src/artifacts.ts`, which is
**shared production code owned by the data-plane milestone**. This milestone's job is the
measurement; changing the guard would change the behaviour every DAT-01…DAT-08 gate asserts,
and `src/data-plane.test.ts` at this HEAD asserts the current behaviour (DAT-05 passes
`requestedRange: {offset: 0}` and expects a whole-file capture, `data-plane.test.ts:1308`).
Repairing it means deciding whether `requestedRange` should (a) narrow the read, or (b) be
removed from the descriptor vocabulary as unimplemented — a design decision with its own
gates, not a measurement. Recorded, not silently patched.

---

## 6. Contradictions with prior claims in `P5-data/` and `R5-data/`

I re-derived what could be re-derived. **No numeric contradiction was found.** What follows
distinguishes confirmed, newly-found, and differently-scoped.

**Confirmed by re-measurement:**

| prior claim | where | my measurement |
|---|---|---|
| raw-cap refusal: `runRipgrep` with a 4096-byte cap over 900 real matches throws `SearchError` / `SEARCH_RAW_OUTPUT_OVERFLOW`, and the generous cap succeeds on the same call | `R5-data/raw-cap-measurement.json` | **Confirmed** — `S7.rawCapTiny` is the identical error name/code/message; `S7.rawCapGenerous` returns all 900 parsed matches |
| the renderer keeps 250 of 900 and says it omitted the rest | `R5-data/raw-cap-measurement.json` | **Confirmed** — `rendererKept 250`, `rendererSeen 900`, `rendererTruncated true`, `renderedSaysItOmitted true` |
| the fixed-size pager is not character-aligned while `pageUtf8ByBytes` is: over `'😀'.repeat(1000)` at page size 997, 4 of 5 individual pages are not standalone-valid UTF-8, reassembly is byte-exact | `R5-data/FINDINGS.md` §3d (G-R5-03) | **Confirmed exactly** — 4/5 invalid, reassembly exact, 0/5 invalid via `pageUtf8ByBytes` |
| `defaultArtifactRoot` reads a `root` the mounted `storageDomain` does not have, so it falls back to the relative `data-artifacts` | `R5-data/FINDINGS.md` §8 (G-R5-04) | **Confirmed in source** — `data-service.ts:400-406` casts `ctx.get('storageDomain')` to `{root?: string}`; `grep -n root` over `packages/storage/storage-domain/src/{index,domain}.ts` returns nothing; the root belongs to the backend (`storage-json/src/index.ts:30`, `z.string().required()`) |
| the `verify-data-plane` probe reports `serviceKind`/`serviceSurface`/`artifactRoot`/`dataToolNames` | `R5-data/FINDINGS.md` §6 | **Confirmed** — present at `qualification/runners/verify-data-plane.mjs:68-70,89-94,138-139`; `R5-data/profile-boot.json` and `M4-data/profile-boot.json` are byte-identical |
| DAT-07's raw cap is 20,000,000 and the artifact's completeness is `complete-within-request` because the cap was not reached | `R5-data/FINDINGS.md` §2 (DAT-07) | **Confirmed** — `rawCapBytes 20000000`, `rawCapReached false` |

**Differently scoped, not contradictory — stated so the difference is not mistaken for one:**

1. **M4 wrote "Real ripgrep 15.0.0" and R5's JSON records the path of
   `@vscode+ripgrep-win32-x64@1.18.0`.** Both are true: the *package* is `@vscode/ripgrep`
   1.18.0 and the *binary* it ships reports `ripgrep 15.0.0 (rev 3a612f88b8)`, which I
   measured directly (`S7.ripgrepVersion`). No contradiction.

2. **The `[DAT-07] rawBytes` values differ between runs** (239,526 in P5, 240,428 in R5,
   241,330 in mine). Not a contradiction — §3c shows the three are exactly one path character
   apart each, at +902 bytes per character, and all are far below the 20 MB cap. Neither prior
   artifact records its path length, so the number is not reproducible from the evidence alone.
   That is the finding, not a discrepancy in the product.

3. **`R5-data/FINDINGS.md` claims "DAT-02 … projection 399 bytes (JS reducer) … 429 (Python
   pipe) … 437 (real ipykernel)" and "512 pages / 33,554,432 bytes".** I re-ran the suite and
   got exactly those numbers, including `[DAT-02-ipykernel] … projectionBytes 437` and
   `cellReachedDataPlane false`. Confirmed.

4. **`R5-data/FINDINGS.md` §3c claims the `indexBytesRead` counter was fixed to increment.**
   Confirmed by the same suite run: `[DAT-06] … indexBytesScanned 4194304 indexBytesRead
   4194304`. Before R5's fix this reported zero.

**Newly found, not previously recorded anywhere in this repo:**

- **T8-12** (`requestedRange` recorded but not honoured) and **T8-13** (the shortfall guard
  disabled by its presence). §3a/§3b. Neither P5 nor R5 measured this; R5's DAT-05 gate
  passes `requestedRange: {offset: 0}` and only asserts the whole-file capture, so the field's
  non-effect is invisible to it.
- **T8-14** (raw tool-output byte counts are not reproducible: +902 B per path character, and
  a 2-byte jitter from ripgrep's own timing field on a fixed path). §3c.

---

## 7. Exact rows requested for `docs/GAPS.md`

`docs/GAPS.md` was **not edited** — it is owned by another agent. These are the rows this work
wants added, in a form that can be pasted.

```markdown
| G-T8-01 | `captureFile` records a `requestedRange` in `coverage` but never narrows the read by it, so a caller asking for 64 KiB of a 1 MiB file gets the whole file with `claimScope: "request"` and `completeness: complete-within-request`. | MEASURED: `acquiredBytes 1048576` and `persistedBytes 1048576` against `requestedRange {offset:0,length:65536}`; `rangeWasHonoured false`. `defaultReadChunks` (`artifacts.ts:1235-1247`) streams offset 0 → EOF regardless. | `qualification/results/T8-data/four-byte-classes.json` scenario `S5_requested_range_not_honoured`; `probe-run.txt`. Gate T8-12. | OPEN — a design decision (narrow the read, or drop the field), not a measurement. |
| G-T8-02 | The acquired-vs-persisted shortfall guard is DISABLED whenever `requestedRange` is present, and because the read is not narrowed, a short read that is correctly `partial` without a range becomes `complete-within-request` with no gap when a range is named. | MEASURED, same 400-of-1000-byte short read twice: without a range → `partial`, 1 × `native-acquisition` gap, `isDeliverableAsComplete false`; with `requestedRange {offset:0}` → `complete-within-request`, 0 gaps, `isDeliverableAsComplete TRUE`. Source: `artifacts.ts:1093`. | `qualification/results/T8-data/four-byte-classes.json` scenarios `S3_short_acquisition` and `S6_shortfall_guard_bypass`. Gate T8-13. | OPEN — this is the collapse `artifacts.ts:1088` says the plane exists to prevent. |
| G-T8-03 | A "raw tool output" byte count is not reproducible from the evidence that records it, on two independent axes: (i) ripgrep's `--json` stdout embeds the absolute path per match; (ii) its trailing `summary` event carries `elapsed.nanos`, whose decimal length varies with search duration. | MEASURED. (i) exactly +902 bytes per path character (7,216 bytes over an 8-character span, 5 samples per length) = 900 matches + 2. (ii) ten identical commands on one path gave raw bytes {241328, 241330} while `bytes_printed` was constant at 240740 and the summary event was 273 or 274 bytes; a second probe reproduced the 2-byte spread at 2 of 5 path lengths. Explains the four different values already in this repo's evidence for the same stimulus (239,526 / 240,428 / 241,328 / 241,330). | `qualification/results/T8-data/four-byte-classes.json` (`S7_tool_output_boundary.rawBytesJitterSamePath`) and `raw-bytes-slope.json`. Gate T8-14. | OPEN — a claim-discipline rule: quote a raw tool-output byte count with its path and a tolerance for the timing field, or do not quote it. |
| G-T8-04 | Production reachability of the data plane through a real composed-profile boot was NOT re-measured this round. | BLOCKED: `qualification/runners/verify-data-plane.mjs:58` writes to the FIXED path `qualification/results/M4-data/profile-boot.json`, another agent's evidence file; the shared boot harness's own header calls a fixed output path "a SHARED MUTABLE RESOURCE" that "produced a false PASS earlier in this project". The in-process substitute (`DataPlaneService` over the real storage domain) is measured and PASSES, but it does not prove the `daily-data-plane` row resolves in a live boot. | Gate T8-15 in `qualification/results/T8-data/GATES.md`; prior evidence remains `M4-data/profile-boot.json`. | OPEN — needs a probe with a caller-owned output path. |
```

---

## 8. What is NOT proven

- **No `data.*` tool row exists**, and no cell can reach the data plane as a native call. The
  consumption in `S1` is host-driven and consumed by a real CPython child over a pipe. The
  ipykernel variant is `data-plane.test.ts` DAT-02 and is a separate run; this probe does not
  use the `ipython` tool at all.
- **No composed-profile boot was run** (T8-15, BLOCKED).
- **The Session transcript's byte count is read in source, not measured.** It is the history
  plane's `canonicalEventBytes`; the four classes here are the data plane's.
- **`consumedBytes` is a count of bytes SERVED to a consumer, not of work done by it.** The
  CPython child's independent tally and digest corroborate that the bytes arrived intact; they
  do not prove the consumer did anything useful with them.
- **No fix is claimed** for §3a/§3b. The defects are measured and recorded, and the shared
  production file was left unchanged.
