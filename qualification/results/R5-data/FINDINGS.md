# R5 — data-plane verification and repair

**Date:** 2026-09-20
**Repo:** `D:\DSH\work\dsh-native-daily` @ `0751e9df` (branch `ipython-native`, **not committed**)
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` — **not modified**
**Environment:** Windows 11 (10.0.26200) AMD64, Node v24.18.0, CPython 3.14.3, ipykernel 7.3.0, ripgrep 1.18.0

**Commands and their exit codes**

| command | exit |
|---|---|
| `node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **0** |
| `node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json` | **0** |
| `vitest run src/data-plane.test.ts` | **0** — 41 tests passed (was 36) |
| probe boot (`dsh --profile daily-candidate --patch …/verify-data-plane.patch.yml --no-open`) | boot_exit=**124** (the timeout killing the long-lived web server; verdict line written first — the same convention M4 recorded) |

**Evidence in this directory:** `tests.txt`, `tsc.txt`, `source-digests.txt`,
`truncation-measurement.mjs`/`.json`, `raw-cap-measurement.mjs`/`.json`,
`ipython-substitution-probe.mjs`/`.json`, `probe-rerun.txt`, `profile-boot.json`.

---

## 1. The truncation contract — CONFIRMED, step by step, re-derived

The prior note (`qualification/results/M4-data/CANONICAL-TRUNCATION-VERIFIED.md`) was
re-derived rather than trusted. Every step holds. File:line are from the pinned
checkout; the measurement is `truncation-measurement.json`, produced by a fresh
process against the REAL `buildWindow`.

| step | claim | source (pinned checkout) | measurement |
|---|---|---|---|
| 1 | The cap is a real constant | `packages/fs/tool-fs/src/read-render.ts:11` `export const READ_MAX_LINE_LENGTH = 2000` | imported value is `2000`; `READ_MAX_BYTES` is `51200` |
| 2 | `truncateLine` keeps the HEAD and APPENDS a suffix | `read-render.ts:69-70` `line.substring(0, maxLineLength)` + `` `... (line truncated to ${maxLineLength} chars)` `` | a 102,400-byte line returns 2,034 chars = 2000 + 34; suffix present; `line.startsWith(clipped) === false` |
| 3 | `buildWindow` caps its line buffer at `maxLineLength + 1` | `read-render.ts:118` `const lineBufferCap = request.maxLineLength + 1`; applied at `:122` and `:124` | a line of exactly 2000 chars is NOT truncated; 2001 chars IS (both 2,034 chars out) |
| 4 | The clip happens on the CANONICAL path | `packages/fs/tool-fs/src/read.ts:157` `lines: window.lines,` inside the returned `outcome` | **measured by CALLING the tool** — see below |
| 5 | The tail marker is gone | — | `tailMarkerSurvives: false`; `interiorBytesLost: 100366` |
| 6 | `offset=2` throws | `read-render.ts:104-106` `finish()` throws when `offset > totalLines` | `offset 2 is out of range for "long.txt" (1 lines)`; through the real TOOL: `isError: true`, code `FS_NOT_FOUND` |
| 7 | A larger `maxBytes` does not help | — | at `maxBytes = 50 MiB` the line is still 2,034 chars, marker still gone |

**The decisive property is step 2's suffix, not step 3's cap.** `substring(0, 2000)`
followed by an appended marker produces a string that is **not a prefix** of the
original, so `slice`/`substring` cannot trim the marker off and recover the head;
and the head is only the first 2000 of 102,400 characters anyway. The interior
100,366 bytes exist in no value the tool ever returns.

**Step 4 was cited from source before; it is now an observation.** `read.ts:157` is
readable, but "the clipped lines ARE the returned value" is the step the whole
capture layer rests on, so R5 mounted the real `read` tool through the real
registry (`SystemPrompt` + `ToolRuntime` + `LocalFileSystem` + `applyReadTool`) and
executed it. Result, asserted in DAT-01:

- canonical value keys are exactly `path, offset, lines, totalLines`
- `totalLines === 1`, one line, `text.length === 2034`, suffix present, `TAILMARKER` absent
- `line.startsWith(text) === false`
- the rendered envelope carries the same clipped line — the model-facing text is a
  faithful view of a value that is already lossy
- `offset: 2` through the TOOL is `isError: true` with code `FS_NOT_FOUND`

**The honest counter-case is asserted too.** The bytes are on disk: the same
`buildWindow` with `maxLineLength: 200_000` returns the line byte-for-byte with the
tail marker intact. So the loss is the **configured cap applied on the way out**,
not a missing file — and what no configuration recovers is the interior of a value
that was already returned clipped. That is precisely why every repair in this
milestone reads **bytes of a captured object** and never `lines[].text`.

---

## 2. Per-gate verdicts, and the assertion actually checked

| gate | verdict | the assertion that was checked (not the claim's wording) |
|---|---|---|
| **DAT-01** | **PASS** | `buildWindow` clips a 102,400-byte line to 2,034 chars, loses 100,366 bytes, and `offset=2` throws — **now measured through the real `read` tool's canonical value**, not only cited from `read.ts:157`. The same line is then recovered byte-for-byte (sha256-equal, tail marker present) from the captured artifact by byte range, via `buildLineIndex` + `readLineBytes`. |
| **DAT-02** | **PASS, substitution removed** | 512 pages / 33,554,432 bytes consumed, digest equal to the source, projection 399 bytes (JS reducer). Repeated by a real CPython process over a pipe: 512 pages, digest equal, projection 429 bytes. **New:** by the product's own `ipython` tool over a real ipykernel: 512 pages, 33,554,432 bytes, digest equal, `artifactBytesRead 33554432`, `artifactReads 512`, projection 437 bytes. |
| **DAT-03** | **PASS** | UTF-8 (3- and 4-byte), CRLF and JSONL swept at page sizes 1…96 and 1,2,3,5,7,16,64,100,997,4096: byte-for-byte equality, no replacement char after reassembly, every record exactly once, line numbering identical to the read tool. **New:** the real pager's boundary is asserted separately — at page size 997, at least one individual page is NOT standalone-valid UTF-8 while reassembly is byte-exact. |
| **DAT-04** | **PASS** | Repeated cursor, backwards cursor, and not-exhausted-without-continuation each raise `pagination-stalled`; a well-formed provider still completes 5/5 pages. **Confirmed as the only mock**, and the mock is labelled in the describe name and here (§4). |
| **DAT-05** | **PASS** | Source rewritten after page 1 (same length, different bytes); page 2 still comes from the captured hash and the join is the ORIGINAL's. A cursor bound to another artifact, and a cursor after a scope bump, are both refused. |
| **DAT-06** | **PASS** | 8 pages of a 4 MiB artifact cost exactly 524,288 artifact bytes in 8 reads; source read once at capture, never during paging; index is one linear scan of 4,194,304 bytes. Repeated `read` **measured**: 5 calls scanned 944,445 bytes against an 188,889-byte file = 5.0× the file. **New:** the index scan is now accounted in `indexBytesRead` (4,194,304), a counter that previously reported zero for every index ever built. |
| **DAT-07** | **PASS, oracle strengthened** | Real ripgrep, 900 matches, 239,526 raw bytes against a 20,000,000 cap: canonical keeps all 900, the renderer shows 250 and reports the omission (`Found 250 of 900 matches`), and real CPython reads all 900 distinct matches from the captured canonical. **The raw-cap test was rewritten** (§3). |
| **DAT-08** | **PASS** | Over-quota capture returns `completeness: "partial"` with a `retention` gap and recovery `none`, publishes nothing (`reference.state === 'missing'`, `reference.artifact === ''`), projection 613 bytes with no content. Orphan / integrity-error / checkpoint-failure windows each reach their required verdict. |

**Non-PASS: none.** Two substitutions and one unproven edge are stated below rather
than folded into a PASS.

---

## 3. What was strengthened, and why

The failure mode named in the brief — **an oracle weaker than its scenario** — was
found in three places. In each case the claim was kept and the test was made
stronger; none was weakened, skipped, or deleted.

### 3a. DAT-01 step 4 was a source reading, now an execution

`read.ts:157` was cited. It is now **executed**: the real `read` tool is mounted
through the real registry and called, and the canonical value is inspected
(§1). Two new assertions came with it: the past-EOF exit through the TOOL is
`FS_NOT_FOUND`, and a raised `maxLineLength` does recover the line — the honest
boundary of the finding.

### 3b. DAT-07's raw-cap test was a tautology

The original test built a `partial` descriptor **by hand** and asserted
`projectForModel` echoed `partial` back. That cannot fail if the product is wrong:
it checks that a projection copies a field it was handed.

The real path was then driven (`raw-cap-measurement.json`): `runRipgrep` with a
4,096-byte cap against 240,428 bytes of real ripgrep output **throws**
`SEARCH_RAW_OUTPUT_OVERFLOW` — it does **not** hand back a truncated match list to
be labelled `partial`. The claim was therefore narrower than the test implied, and
the test now asserts both halves:

1. the **real** refusal, with the generous cap run first so the overflow is proven
   rather than assumed;
2. the projection shape for a caller that has *established* the acquisition is
   partial, plus `isDeliverableAsComplete(partial) === false` and
   `isDeliverableAsComplete(complete) === true` — the property that stops a
   `partial` observation from reading as success.

### 3c. DAT-06's `indexBytesRead` counter could not move

`IoCounters.indexBytesRead` existed as a field but **nothing ever incremented it**:
`buildLineIndex` called `store.openRange(..., undefined, signal)`, passing no
counters. Every index reported zero. A counter that cannot move is worse than no
counter, because it reads as a measurement. Fixed in `artifacts.ts`:
`buildLineIndex` now accepts `options.counters`, passes it to `openRange`, and
increments `indexBytesRead`. DAT-06 asserts `indexBytesRead === 4,194,304` and
`indexBytesRead === artifactBytesRead` (the index scan is a subset of the artifact
bytes, asserted so the two cannot drift into meaning different things).

**Production surface change, stated:** `buildLineIndex`'s third parameter gained an
optional `counters` field. This is additive — no existing call site changes
behaviour — and it is the only production code change R5 made to `artifacts.ts`.

### 3d. DAT-03's real-pager boundary was unstated

The gate's UTF-8 claim was carried by `pageUtf8ByBytes`, which **is**
character-aligned by construction — but the production pager (`pages` /
`walkPages`) does not use it: it serves fixed-size byte windows, because the cursor
is a byte position. Measured: at page size 997 over `'😀'.repeat(1000)`, 4 of 5
individual pages are not standalone-valid UTF-8, while reassembly is byte-exact and
`pageUtf8ByBytes` keeps every page valid. Both facts are now asserted separately so
neither is inferred from the other, and a consumer that needs per-page validity
knows which function to use.

### 3e. DAT-04's mock is now labelled at the point of use

The describe name already carried `[mock provider]`. R5 added the structural
reason at the block: a correct provider **cannot** return a repeated or backwards
cursor, because the cursor is minted from the position the page ended at — so the
guard is unreachable through the real provider, and a test that only used the real
provider would assert nothing. The counterweight (the same driver over the REAL
store must still finish 5/5 pages) is stated as the reason the guard is not
over-firing.

---

## 4. Real vs fake substrate, per gate

| gate | substrate | why a real one is or is not possible |
|---|---|---|
| DAT-01 | **real** | Production `LocalFileSystem`, production `publishImmutableObjectStream`, the REAL `buildWindow`, and (new) the REAL `read` TOOL executed through the real registry. |
| DAT-02 | **real** | Production store + REAL CPython process over a pipe + (new) the REAL `ipython` tool over a REAL ipykernel (`ipykernel.zmqshell`). The one thing that cannot be real: a cell calling `data.pages` — see §5. |
| DAT-03 | **real** | Real files, real capture, real byte ranges. The `pageUtf8ByBytes` sweep is a library function over real bytes; the pager boundary is measured on the real pager. |
| DAT-04 | **mock — the ONLY one** | A synthetic `PageProvider`. **Structural, not a shortcut:** a correct provider cannot return a repeated or backwards cursor, so the guard is unreachable through the real provider. Labelled `[mock provider]` in the describe name and here. The happy path in the same block runs over the REAL store. |
| DAT-05 | **real** | Real file rewritten on disk between pages; real artifact; real cursors. |
| DAT-06 | **real** | Real artifact store with real `openRange` accounting; the repeated-`read` measurement wraps the REAL `buildWindow`'s input iterable, which is the only place it touches input. |
| DAT-07 | **real** | Real ripgrep 1.18.0 binary resolved via the production `resolveRgPath`, the production `parseGrepMatches`/`retainGrepMatches`, and a REAL CPython process reading the canonical set. The raw-cap overflow now also goes through the production `runRipgrep`. |
| DAT-08 | **real** | Real file, real store with a 16 KiB quota, real quota error found through the cause chain. The orphan window uses the in-memory log's documented test seam (`failNextCommit`) — the crash window itself is covered separately by a REAL `SIGKILL`. |
| crash consistency | **real** | A forked child is **really `SIGKILL`ed** between `put` and `commit`; the surviving object is verified against its address by a fresh process. |

---

## 5. The `python_exec` substitution — DECIDED: replaced for the consumption, still impossible for the native call

**The decision, and the measurement behind it.**

M4's report admitted `dataToolPresent: false` and substituted a bare `python -c`
process, on the stated grounds that `packages/dsh-ipython` (M3) did not exist. It
exists now. So the question was re-opened and answered by measurement
(`ipython-substitution-probe.json`):

| question | measured answer |
|---|---|
| Does the product's own `ipython` tool drive a real kernel from THIS package's test environment? | **Yes.** `ctx.tools.execute({ name: 'ipython' })` returns `outcome: ok`, and the cell reports `REAL_KERNEL (3, 14) ipykernel.zmqshell`. |
| Can a cell reach the data plane (a native `data.pages` call)? | **No.** A cell probing `data`, `tools`, `dsh`, `dailyData` finds none of them; `import data` raises `ModuleNotFoundError`. |
| Can a cell receive 512 pages served by the host, so the walk stays on the artifact? | **Yes.** A real ipykernel consumed 512 pages / 33,554,432 bytes with `artifactBytesRead 33554432` and `artifactReads 512`; the digest matched the source; projection 437 bytes. |

**What was done.** DAT-02 gained a real test — *"has the REAL `ipython` tool over a
REAL ipykernel consume all 512 pages"* — that runs the consumption through the
product's own tool against a real ipykernel, with the real artifact store serving
and the real counters proving where the bytes came from. The bare `python -c` test
was **kept**, because the process-boundary property it measures is still real and
cheaper to run; it is no longer the strongest evidence. The describe label changed
from `[real capture / mock consumer]` to `[real capture / real consumers]`, which is
now accurate.

**What still cannot be real, stated precisely.** A cell cannot call
`data.capture_file` / `data.pages` as NATIVE tools, for two independent reasons,
both checked in source:

1. **No tool rows exist.** Nothing anywhere in this tree registers a `data.*` tool.
   The intended owner was the M3 worker; M3 shipped ONE tool (`ipython`, one `code`
   parameter — M12 `surface.json` confirms `ipythonIsOnlyParameter: true`).
2. **M3 exposes no cell-to-host call channel.** `src/broker.py` registers no
   `comm` (`grep -c "comm_open|comm_msg|register_comm|dsh_call|host_call"` → **0**),
   injects no host object into the user namespace, and starts the kernel through a
   plain `jupyter_client.KernelManager` with no startup script or
   `user_expressions` channel. The only channels are the length-prefixed control
   frames on fd 7 (host↔broker, not cell↔host) and IOPub (one-way).

So the M3 native-call path is a **real gap, not a substitution that can be closed
from this milestone**. The test asserts the absence (`import data FAILED:
ModuleNotFoundError`) rather than leaving it implied, so the green result above
cannot be read as "a cell can page". The page walk in that test is driven FROM the
host and consumed by the kernel over loopback — a real kernel and a real artifact,
but not the M3 native-call path.

---

## 6. Production reachability — CONFIRMED through the real resolver

Re-run with the probe host of the dead agent confirmed absent and port 3080 free
before starting; `--no-open` used; the host was killed by the harness timeout and
the port verified released afterwards (no LISTENING socket on 6115 or 3080, no
`verify-data-plane` process).

```
DSH_HOME=D:/DSH/home/canary3 node apps/cli/lib/bin.js --profile daily-candidate \
  --patch D:/DSH/work/dsh-native-daily/qualification/runners/verify-data-plane.patch.yml --no-open
```

```
VERIFY-DATA-PLANE: {"servicePresent":true,"serviceKind":"DataPlaneService",
 "serviceSurface":["capture","page","walk","lineIndex","readLine","readRange","resolve","reconcile"],
 "artifactRoot":"data-artifacts","grantRevision":1,"captureState":"durable","capturedBytes":162,
 "readBackMatches":true,"sessionCreated":true,"sessionId":"session-e80b715f-…",
 "toolCountAgentKey":26,"dataToolPresent":false,"dataToolNames":[],"error":null,"tools":[…26 names…]}
```

The chain `cordis.patch.yml → data-plugin → data-service → artifacts → observations`
is **unbroken and now proven by identity, not by a boolean**. R5 added three fields
to the probe because `servicePresent: true` alone does not distinguish a correctly
wired service from a stub registered under the same name:

- `serviceKind: "DataPlaneService"` — the object came back as the CLASS from
  `data-service.ts`, not a look-alike;
- `serviceSurface` — all 8 methods `data-service.ts` composes from `artifacts.ts`
  are present as functions (any broken import in the chain removes one);
- `artifactRoot: "data-artifacts"` — the root was derived by
  `defaultArtifactRoot(ctx)` from the storage domain, so the service reached
  `ctx.storageDomain`; and `dataToolNames: []` makes `dataToolPresent: false`
  checkable rather than a bare negative.

**The two recorded probe bugs were NOT re-introduced.** `inject` is gated on
`dailyData` (gating on `storageDomain` wins the race and reports a FALSE absence),
and every `webserver` config key is restated because a patch replaces the whole
`config` object rather than deep-merging it (overriding only `port` dropped `host`
and failed schema validation).

**What I added to the SHARED files: nothing.** `packages/dsh-daily-work/cordis.patch.yml`
already carried the `daily-data-plane` row and `package.json` already carried the
`./data-host` export (both present in the working tree before R5; `git diff` shows
+162 and +22 lines from earlier work, with no R5 additions). The probe's own patch
restates the row, and that restatement is **load-bearing and now measured**: the
INSTALLED profile copy under `D:\DSH\home\canary3\profiles\daily-candidate\cordis.patch.yml`
contains **0** occurrences of `daily-data-plane` — it is a stale copy from before
the row existed. Without the restatement the probe would report a false absence
caused by a stale install, not by the product.

---

## 7. The open architectural item — CONFIRMED as a real limit

The M4 note recorded that the reference log is a **storage domain**
(`dsh_daily_data`), not a Session event, because `SessionEventMap` is closed and an
`ignorable` event cannot carry the "event committed" half of the ordering. Verified
against the pinned checkout; **it holds**.

1. **The map is closed and augmentation is rejected by design.**
   `packages/core/session/src/types.ts:269` declares `export interface SessionEventMap`;
   `:409` derives `SessionEventType = keyof SessionEventMap`. It IS declaration-merged
   by in-repo packages (`agent/src/types.ts:81`, `tools/src/types.ts:28`, …), but the
   persistence catalog generator **hard-errors** on an out-of-repo augmentation:
   `scripts/gen-persistence-catalog.ts` and its spec require a member to live in the
   owning package (`gen-persistence-catalog.spec.ts` asserts the refusal *"top-level
   interface SessionEventMap … is outside @deepseek-ai/dsh-session"*, and rejects
   `extends` clauses because *"inherited keys would join keyof SessionEventMap without
   a catalog row"*). So an out-of-repo plugin cannot add a REQUIRED event type.
2. **An `ignorable` event is genuinely skippable.** `types.ts:488` documents
   `ignorable?: true` as *"Marks an event a reader may safely skip when it does not
   recognize `type`"*, and the read paths act on it:
   `packages/session/session-persistence/src/storage-contract.ts:75` refuses an
   unknown non-ignorable type, while `surface.ts:285` and
   `session-log-deepseek/src/index.ts:93` **return early / pass through opaquely** for
   an unknown ignorable one.
3. **Therefore the substitution is forced, not chosen.** The commit order needs a
   boundary a reader MUST observe ("the reference is committed"). An event a reader
   may skip is not that boundary. The durable medium an extension can actually reach
   is the storage domain the run record already uses, keyed by observation id so the
   reconcile path can enumerate it — which is what `StorageReferenceLog` implements,
   with `commit` resolving only after the backend's write chain accepted the row.

**No event type was invented**, and none should be. This is a real limit of the
platform as pinned, and it stays recorded. The one thing worth naming as a residual:
`SessionReferenceLog` is a PORT (`artifacts.ts`), so if a later DSH release exposes a
required out-of-repo event slot, the substitution is a single implementation swap
behind that port rather than a re-architecture.

---

## 8. What is NOT proven

- **No cell can call `data.capture_file` / `data.pages`.** No `data.*` tool row
  exists, and M3 exposes no cell-to-host call channel (§5). The consumption in
  DAT-02's real-kernel test is host-driven and kernel-consumed over loopback.
- **No `python_exec` integration is claimed** — no ipykernel lifecycle, interrupt,
  or native-tool callback is exercised by this milestone. Those are M11's.
- **No exactly-once external-effect claim.** The crash tests are about what the
  record may SAY after an interruption.
- **The reference log is not a Session event** (§7). It is durable in the storage
  domain, not in the session log, and a reader of the session log alone cannot see it.
- **DAT-07 drives ripgrep and the retention functions through the library, not
  through a mounted agent turn.** The claim is about the retention layering.
- **The `partial` labelling of a raw-cap hit is a CALLER decision.** The product
  throws `SEARCH_RAW_OUTPUT_OVERFLOW`; nothing in the shipped path converts that into
  a `partial` descriptor with a `native-acquisition` gap. DAT-07 asserts the real
  refusal and the projection shape separately, and the join between them is not
  implemented in production.
- **`artifactRoot` in the boot probe resolved to the relative `data-artifacts`.**
  R5 traced this to source rather than leaving it as an unexplained observation:
  `defaultArtifactRoot` reads `ctx.get('storageDomain')?.root`, but the mounted
  `DomainFacility` (`packages/storage/storage-domain/src/index.ts:69`) has **no
  `root` property at all** — `grep -n root` over `index.ts` and `domain.ts` returns
  nothing, and the root belongs to the BACKEND (`storage-json` takes `root` as its
  own required config, `storage-json/src/index.ts:30`). So the `configured` branch
  is **unreachable against the shipped service**, and the documented preference
  ("artifacts live beside the records that reference them") does not take effect on
  any deployment built this way. The fallback is a relative path, resolved against
  the process cwd — private, but not tied to the store that references the objects.
  This is a real defect in the derivation, recorded rather than smoothed over; it is
  NOT fixed here because a correct fix needs a storage-domain change outside this
  milestone's ownership.
- **The probe's `readBackMatches` is a string comparison on a 162-byte payload.** It
  proves the commit order completed; it is not a large-object integrity proof (that
  is DAT-01's sha256 and the crash test's `store.verify`).
- **Nothing was committed.** The tree is left dirty on purpose, per the brief.

---

## 9. Exact rows requested for `docs/GAPS.md`

`docs/GAPS.md` was **not edited** (it is owned by another agent). The rows below are
the ones this work wants added, in a form that can be pasted.

```markdown
| G-R5-01 | No `data.*` tool row exists, and M3's broker exposes no cell-to-host call channel, so a Python cell cannot reach the data plane as a native call. | MEASURED, not inferred. (a) Nothing in the tree registers a `data.capture_file`/`data.pages` row. (b) `packages/dsh-ipython/src/broker.py` registers no comm (`grep -c "comm_open\|comm_msg\|register_comm\|dsh_call\|host_call"` → 0), injects no host object into the user namespace, and starts the kernel via a plain `jupyter_client.KernelManager` with no startup script or `user_expressions` channel. A cell probing `data`/`tools`/`dsh`/`dailyData` finds none; `import data` raises `ModuleNotFoundError`. | `src/data-plane.test.ts` DAT-02 asserts the absence explicitly, so the real-kernel PASS cannot be read as "a cell can page". Evidence: `qualification/results/R5-data/ipython-substitution-probe.json`. | OPEN — M3 owns the tool rows; this milestone owns the seam they bind to. |
| G-R5-02 | The raw-cap hit is refused (`SEARCH_RAW_OUTPUT_OVERFLOW`), never converted into a `partial` observation, so no shipped path produces the `native-acquisition` gap DAT-07's claim implies. | MEASURED: `runRipgrep` with a 4096-byte cap against 240,428 bytes of real ripgrep output throws `SearchError`/`SEARCH_RAW_OUTPUT_OVERFLOW`; the generous cap succeeds on the same call. | `qualification/results/R5-data/raw-cap-measurement.json`. DAT-07 now asserts the real refusal AND the projection shape separately, so the unimplemented join is visible rather than implied. | OPEN — a deliberate narrowing of the claim, not a defect to fix by loosening it. |
| G-R5-03 | The production pager serves fixed-size BYTE windows, so an individual page is not guaranteed to be independently decodable; `pageUtf8ByBytes` is the character-aligned alternative and is not used by `pages`/`walkPages`. | MEASURED: over `'😀'.repeat(1000)` at page size 997, 4 of 5 individual pages are not standalone-valid UTF-8, while reassembly is byte-exact. At 64 KiB over 160,000 bytes, 0 of 3 pages were invalid (alignment is content-dependent). | `src/data-plane.test.ts` DAT-03 asserts both facts separately. | OPEN — inherent to a byte-addressed cursor; consumers needing per-page validity must reassemble or use the aligned splitter. |
| G-R5-04 | `defaultArtifactRoot` reads a `root` property that the mounted `storageDomain` service does not have, so the documented "artifacts live beside the records that reference them" preference is unreachable and every deployment falls back to the relative `data-artifacts` (resolved against process cwd). | MEASURED in the real boot: `"artifactRoot":"data-artifacts"`. TRACED to source: `DomainFacility` (`packages/storage/storage-domain/src/index.ts:69`) declares no `root` (`grep -n root` over `index.ts` + `domain.ts` → nothing); the root belongs to the BACKEND (`storage-json/src/index.ts:30`, `root: z.string().required()`). `data-service.ts:381` casts `ctx.get('storageDomain')` to `{ root?: string }`, which the service never satisfies. | `qualification/results/R5-data/profile-boot.json`; `packages/dsh-daily-work/src/data-service.ts:380-386`. | OPEN — a real derivation defect. The fix needs a storage-domain change (or a config-supplied root) and is outside this milestone's file ownership; NOT fixed here. |
```
