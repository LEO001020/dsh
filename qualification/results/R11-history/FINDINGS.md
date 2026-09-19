# R11 — independent re-verification of M7 (history plane, web provenance)

**Date:** 2026-09-20
**Role:** R11. Independent verification and repair. The M7 report and the P9
verification report were both treated as **claims**, not evidence. Where a claim
was load-bearing I re-derived it from source and, where it was falsifiable, I
falsified the mechanism and watched the oracle fail.
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
— **not modified by this run** (the one pre-existing `M` in its `git status` is
`packages/deliverables/workspace-changes/src/index.ts`, another agent's file,
untouched by me).
**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`. **No commit was made.**

---

## Headline

| # | Claim | R11 verdict |
|---|---|---|
| 1 | `ctx.get` fix + two regression tests pin it | **FIX CONFIRMED. THE PIN WAS REFUTED, and P9's repair is CONFIRMED to have teeth.** I reproduced P9's refutation independently and measured the replacement test failing with the property form. |
| 2 | HIS-04 counts replays two ways | **CONFIRMED**, both arms falsified by me in both directions. |
| 3 | `readEvent` is O(log); a `scan` option slices the pinned observation | **CONFIRMED**, and falsified. |
| 4 | Upstream prepared-cache never hits | **CONFIRMED in source by the root agent; recorded at `docs/GAPS.md` G-SEAM-23.** Not re-litigated here. |
| 5 | All reads via `ctx.sessionQuery`; no second store; sync wrappers only in a comment | **CONFIRMED.** |
| — | Production wiring through the real profile resolver | **CONFIRMED** by re-running the boot probe. **I strengthened the probe**, which had a real weakness (§5). |
| — | Does the service have a real consumer? | **NO. It is a service with no consumer** — the unwired-module class, recorded at `docs/GAPS.md` row 4. I did **not** invent a caller. |

**Test count: the recorded 84 was correct when written, but the file has since
moved. The current true count is 85.** See §1.

---

## 1. Test count — re-run, and a correction to the record

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/history-web.test.ts
```

| run | count | exit |
|---|---|---|
| M7 recorded (`M7-history/tests.txt`) | 84 | 0 |
| R11 first run at 03:06 | **84** | 0 |
| R11 after the file changed at 03:07 | **85** | 0 |
| R11 final, all falsification runs reverted | **85** | 0 |

**The recorded evidence was not stale — it was correct for the revision it
described.** `M7-history/tests.txt` is dated 02:04 and the test file was written
again at **03:07:06** by the P9 verifier, which added one test and corrected a
false comment (`P9-history/FINDINGS.md` §3.1). So the 84→85 delta is a *known,
documented* addition, not drift.

I verified the delta is exactly one added test by diffing the recorded test names
against the current run: the only new name is
`reads from a PLUGIN caller, the fiber the boot failure actually hit`.

Per-gate counts, counted from the current run rather than copied from notes:

| gate | tests | gate | tests | gate | tests |
|---|---|---|---|---|---|
| HIS-01 | **10** (was 9) | WEB-01 | 3 | WEB-06 | 4 |
| HIS-02 | 6 | WEB-02 | 3 | WEB-07 | 5 |
| HIS-03 | 7 | WEB-03 | 5 | WEB-08 | 7 |
| HIS-04 | 3 | WEB-04 | 3 | ECO-04 | 4 |
| HIS-05 | 4 | WEB-05 | 8 | | |
| HIS-06 | 2 | HIS-07 | 3 | HIS-08 | 3 |

HIS-01 is 10 because that is where the new regression test lives. Every other
gate count matches the M7 report exactly.

---

## 2. Per-gate status

All 17 gates are **PASS**. The right-hand column states the assertion I actually
checked, not the requirement text.

| gate | status | the assertion R11 checked |
|---|---|---|
| HIS-01 | **PASS** | `openScan` on a foreign-workspace id rejects with `HISTORY_SESSION_UNAUTHORIZED` **and the observation spy is still empty** (`history-web.test.ts:289`) — the refusal happens before any read. Refusal and absence are separate codes. |
| HIS-02 | **PASS** | `continueScan` takes `watermark` and `observation` from the **pinned map entry** (`history-plane.ts:575-596`) and never calls `#takeObservation`; a superseded cursor throws `HISTORY_WATERMARK_SUPERSEDED`. Falsified as a side effect of §3.2(b): removing the pin made 3 tests fail. |
| HIS-03 | **PASS** | An oversized event returns `kind:'segments'` with `totalBytes`, `digest`, `recovery:'authorized-refetch'` and **no `event` field on that branch** (`history-plane.ts:687-703`); the segment list is capped at `SEGMENT_COUNT_BUDGET = 4` so offsets cannot become the payload. |
| HIS-04 | **PASS — measured, falsified twice** | §3.2. |
| HIS-05 | **PASS** | `visibilityLedger` is constructed **from** session-query's own `SessionEventRecord[]` (`history-plane.ts:974-980`); `stored` is session-query's `SessionEventSurface`, imported (`history-plane.ts:61-65`), not a local re-classification. |
| HIS-06 | **PASS** | Both memory versions persist, `supersedes` links them, each keeps its own `source`. |
| HIS-07 | **PASS** | `authorityOf` reads `author` only; `capabilitiesFor` ignores its argument. Scoped to this code — see §7. |
| HIS-08 | **PASS** | Rebuild proven against the **real SQLite FTS5 backend** after deleting its file. |
| WEB-01 | **PASS** | `truncated:true` → `partial` + `provider-acquisition` gap with `recovery:'refetch'`; the recovery vocabulary has no local-recovery member. |
| WEB-02 | **PASS** | Uncursored top-10 is `mayBeMore:'unknown'`; only a seam cut is `'true'`. |
| WEB-03 | **PASS** | A failed/empty conversion returns **no** derived body — it does not fall back to raw HTML. |
| WEB-04 | **PASS** | Refetch is a new observation; old hash/time/etag survive; change detected from ETag **or** body hash; no "current body for this url" lookup exists. |
| WEB-05 | **PASS** | Four separate refusals driven against a **real loopback HTTP server that answers 200 to a `Range` request**, started and torn down inside the test. |
| WEB-06 | **PASS** | Quote located at real byte offsets, verified by re-slicing the artifact; a snippet is refused as `snippet-is-not-full-text`; a non-occurring quote is `unsupported`. |
| WEB-07 | **PASS** | Injection recorded as findings, text passes through verbatim; the untrusted record has no field that could carry authority; the notice is asserted **equal** to DSH's own `trust.ts` string. |
| WEB-08 | **PASS** | `empty` is an extractor outcome with `unknown` coverage and an explicit `doesNotMean`; decode errors and budget stops are separate; a **real 64 MiB deflate bomb** is stopped at the bound. |
| ECO-04 | **PASS** | The assembled prefix is **byte-identical** across three cells that change only budget/variables. |

I did not re-derive all 85 assertions. For each gate I read the load-bearing one
and, where a gate's whole claim rests on a single mechanism, I broke that
mechanism and watched the gate fail (§3). "Falsified" below means: mutated a
scratch copy, observed the FAIL, restored, and verified the sha256.

---

## 3. The five claims, adjudicated

### 3.1 Claim 1 — `ctx.get` fix and its regression tests: **FIX CONFIRMED, PIN REFUTED, P9's REPAIR CONFIRMED**

**The fix is real and present.** `ctx.get('sessionQuery')` at five production
sites: `history-plane.ts:184, 843, 901`; `history-plugin.ts:111, 127`. The only
other occurrences of the string `ctx.sessionQuery` in those files are a section
comment (`history-plane.ts:813`) and an **error-message string literal**
(`history-plugin.ts:129`) — neither is a read. `inject` is `[]`.

**The pin claim is REFUTED, and I reproduced the refutation myself.** I restored
`ctx.sessionQuery` at all five sites and ran the suite:

```
FALSIFY run — all 5 sites back to the property form, source only:
  vitest run src/history-web.test.ts  ->  exit 1,  1 failed | 84 passed (85)
  the ONLY failure:
    HIS-01 > reads from a PLUGIN caller, the fiber the boot failure actually hit
    AssertionError: expected 'cannot get property "sessionQuery" wi…' to be null
```

This is the load-bearing result, and it cuts both ways:

- The **pre-existing** test
  (`reads through ctx.get rather than ctx.sessionQuery, so a plugin without
  inject works`) **still passed** with the property form restored. So the M7
  report's claim that "two tests pin it" is **false for that test** — it does not
  reproduce the failure whatever form the plugin uses.
- The **added** test (`reads from a PLUGIN caller…`) **is the only test in the
  file that fails**. Its oracle has teeth. P9's repair is genuine.

**The mechanism, verified in the pinned source rather than taken on trust.**
The inject check is evaluated against the **caller's** fiber:

- `ctx.get(name)` → `getTraceable(this.ctx, …)` (`vendor/cordis/src/reflect.ts:233-235`)
  → `createTraceable`, which captures `ctx` in the returned proxy
  (`vendor/cordis/src/utils.ts:165-197`).
- The property trap reaches `if (!ctx.fiber.runtime) return ctx.reflect.get(prop, false)`
  (`reflect.ts:152`) — the root fiber has `runtime === null`
  (`vendor/cordis/src/fiber.ts:311-315`, the `else` branch of the constructor),
  so a **root-context call short-circuits and never throws**.
- Both pre-existing tests call from the root context. The new test calls from a
  real plugin fiber, which is the production shape.

So the sharpened statement is: *mounting through a real plugin fiber is
necessary but not sufficient; the **call** must also originate from a non-root
fiber.* P9 reached this and I confirm it by independent falsification.

**Consequence for the record:** the boot probe is the only oracle in M7 that
catches this defect class end to end. That is a stronger argument for the boot
probe than the M7 report made, and a **weaker** claim for the unit suite than the
report made.

### 3.2 Claim 2 — HIS-04 measures replays two ways: **CONFIRMED, both arms falsified in both directions**

**(a) The counter is incremented by the real read path.** `#takeObservation`
(`history-plane.ts:713-719`) is called from exactly **one** place, `openScan`
(`:536`), and nowhere in `continueScan`. It increments only when the observation
reports `materializedFullLog`, which the production observer sets to `true`
(`:879`) from the single `observeSession` lease. So `total === 1` is a
consequence of the pin, not a constant.

**Falsification 1 — delete the increment.** 3 tests fail, including the control:

```
Tests  3 failed | 82 passed (85)
  HIS-04 > measures ONE full-log materialization for a 100-page traversal
  HIS-04 > counts a full-log materialization when the plane is asked for a fresh scan
  HIS-04 > reuses the underlying prepared observation lease across scans
```

**Falsification 2 — remove the pin** (make `continueScan` re-observe per page):

```
Tests  3 failed | 82 passed (85)
  → expected 100 to be 1   (x3)
```

**The control arm has teeth, and it is an independent scan.** The
`counts a full-log materialization…` test asserts 1, then `closeScan` + reopen,
then 2 (`history-web.test.ts:903-917`). Because `#takeObservation` runs only in
`openScan`, the second value can only come from a second scan — this is the arm
that makes `1` non-constant, and falsification 1 proves it moves.

**(b) The byte measurement is real physical I/O, not a computed constant.**
The test subclasses `JsonlSessionPersistence`, overrides `open()`, and wraps the
**real** `handle.read` returned by `super.open`, summing
`canonicalEventBytes(event).byteLength` over the events that actually came back
(`history-web.test.ts:796-814`). The assertion set is `logReads === 1`,
`oneLog > 400_000`, `bytesRead < 1_000_000`, `bytesRead * 100 > 40_000_000`.

**This is the decisive check, and falsification 2 supplies it:** removing the pin
drove `logReads` from 1 to **100**. The counter the test asserts on is the
physical read count at the storage handle, and it moves with the mechanism.
The byte figure is therefore a measurement, not a constant.

**One honest caveat, restated from P9 and confirmed:** the "~50 MB for a
per-page replay" figure is a **projection** from the measured `oneLog`
(500 KB × 100 pages), not a second measured run. The measured facts are: **1
physical log read, <1 MB for a traversal whose per-page cost would be ~500 KB
each.** The test labels this as scale, not as a measurement.

### 3.3 Claim 3 — the correction to its own brief: **CONFIRMED, and falsified**

The brief said `readEvent` returns the full event "plus a bounded window". The
agent corrected this: correct, but **O(log)** per call, because
`sessionQuery.readEvent` → `_readEvent` → `this._corpus.load(...)`
(`packages/session-query/session-query/src/index.ts:369-370`) reads the complete
log for a persisted session.

The fix — a `scan` option so an event read slices the already-pinned observation
— is at `history-plane.ts:661-666`, and it routes to
`pinned.observation.events[seq]` when a matching open scan exists.

**Falsification — ignore the `scan` option** (always call `#readFullEvent`):

```
Tests  2 failed | 83 passed (85)
  HIS-03 > reads an event from the pinned observation, so an event read does not re-read the log
  HIS-03 > reports an event absent from the pinned scan as absent, not as an empty event
```

The test measures the contrast **in both directions** (`history-web.test.ts:765-780`):
5 pinned reads cost **0** additional log reads; 3 unpinned reads cost **3**. That
is a stronger form of the correction than the M7 report gave it.

### 3.4 Claim 4 — the upstream observation-cache defect: **CONFIRMED (root agent, in source); recorded**

Not re-litigated, per the brief. Verified only that it is recorded in the right
place: **`docs/GAPS.md` G-SEAM-23** carries the key comparison
(`observation.ts:209`), the `createTraceable` → `new Proxy` citation
(`utils.ts:124,165-166`), the measurement (6 observations, `cacheSize: 32`,
6 full log reads), the escape (`proxy[symbols.original]`), and the fact that this
project is not exposed because the plane pins its own observation. I did not
edit `docs/GAPS.md`.

### 3.5 Claim 5 — reuse, no second store, no prohibited wrappers: **CONFIRMED**

| claim | how R11 checked | result |
|---|---|---|
| reads go through `ctx.sessionQuery` | enumerated every service call in the production wiring | exactly four: `filterSessions` (`:195`, header-only authorization probe), `observeSession` (`:856`), `readEvent` (`:884`), `readSession` (`:908`). No fifth. |
| imports `buildSessionEventRecords` + `SessionEventSurface` rather than re-classifying | read the import block (`:58-65`) and `visibilityLedger` | confirmed |
| `eventAt` / `snapshotEvents` / `ownEvents` only in a comment | `grep -rn` over all three production files | **exactly two hits, both comment lines** (`history-plane.ts:47-48`), in the header recording why they are not used. Zero code occurrences. |
| no second store, no DB, no owned log | listed **every** import of all three production files | `@deepseek-ai/cordis`, `dsh-session`, `dsh-session-query`, `dsh-web`, `node:buffer`, `node:crypto`, `node:zlib`. **No sqlite, no database handle, no fs write path.** |
| no production importer other than the plugin | `grep` for importers of both modules | only `history-plugin.ts`. Nothing else. |
| the plane does not hand out the service | structural test asserts no own/prototype property matches `/service\|query\|engine\|store\|corpus\|observe/i` and that `.sessionQuery` is `undefined` | confirmed, and the enumerated private fields (`#caller`, `#corpus`, `#observe`, `#readFullEvent`, `#replays`, `#generation`, `#openScans`) none match — the guard is not vacuous. |

---

## 4. Production reachability — re-run, CONFIRMED

Through the **real profile resolver**, not by reading the patch:

```
cd /d/DSH/src/dsh-src
export DSH_HOME='D:\DSH\home\canary5'
node apps/cli/lib/bin.js --profile daily \
  --patch 'D:\DSH\work\dsh-native-daily\qualification\runners\verify-m7-history.patch.yml' --no-open
```

Result (`boot-probe.txt`; `boot_exit=124` is the web host not self-exiting, not a
boot failure — the probe line is written before it):

```json
{"dailyHistoryServicePresent":true,"sessionQueryServicePresent":true,
 "historyAvailable":true,
 "selfRead":{"eventCount":1,"exhausted":false,"watermarkSeq":2,"generation":1},
 "foreignReadRefused":true,"foreignRefusalCode":"HISTORY_SESSION_UNAUTHORIZED",
 "pageTraversal":{"pages":3,"eventsSeen":3,"exhausted":true,"truncatedAtPageCap":false,"replayCount":1},
 "replayCounterControl":{"afterFirstScan":1,"afterSecondScan":2,"controlHasTeeth":true},
 "provenanceRecord":{"completeness":"partial","gapRecovery":["refetch"],"hashProves":"…"},
 "untrustedContent":{"trust":"untrusted-data","findingCount":2,
   "findingIds":["imperative-command","authority-claim"]},
 "consumerReach":{"ipythonKernelServicePresent":true,
   "ipythonKernelServiceHasHistoryBinding":false,"historyToolRegistered":[]},
 "error":null}
```

The refusal is the load-bearing part and it is present: a foreign-workspace read
is **REFUSED with `HISTORY_SESSION_UNAUTHORIZED`**, not answered with an empty page.

**Both recorded traps were checked against the resolved tree, and neither bites:**

- *A patch entry replaces the target row's whole `config`.* Verified in
  `vendor/include/src/index.ts:120-123` — it is literally `target[key] = value`,
  not a deep merge. The `daily-history` row contributes **no `config` block at
  all**, so there is nothing to truncate. This trap does not apply here.
- *`inject` is a readiness gate.* The probe declares
  `inject = ['sessionController']`, and it reads `dailyHistory` via `ctx.get`
  only **after** awaiting `sc.create(...)`, i.e. after activation settled.
  `--dump-config` puts `daily-history` at position **591** and the probe row at
  **624**, so the probe activates after the service row.

**Shared files: I added nothing.** `cordis.patch.yml` already carries the
`daily-history` insert row and `package.json` already carries
`exports["./history"]`, resolving to a real built file. **No shared file was
modified by R11.**

`lib/` was rebuilt from current source and came back **byte-identical**
(`history-plane.js` `a33a888e…`, `history-plugin.js` `cb60e242…`), so the built
artifact faithfully reflects the source under test and the boot probe is
exercising the code that was verified.

---

## 5. What I strengthened

**The boot probe had a real weakness, and I fixed it rather than reporting
around it.** The probe's traversal loop was written as `openScan(maxEvents: 8)`
followed by `continueScan(maxEvents: 1)` in a `while` loop, with a comment
claiming a "100-page traversal". A freshly created session has ~3 events, so the
**first page exhausted the scan, the loop never ran, and the probe recorded
`pages: 1`** — reproduced in my own first run, and visible in the M7 and P9
recordings too. `pages: 1` cannot distinguish a pinned scan from a per-page
re-observer, because no page 2 is ever taken. That is exactly the
weaker-oracle-than-scenario defect this project keeps recording.

Two changes to `qualification/runners/verify-m7-history.mjs` (my file):

1. **Page one event at a time**, bounded by `MAX_PAGES = 200`, and record
   `pages`, `eventsSeen`, `exhausted` and `truncatedAtPageCap`. The traversal is
   now genuinely multi-page on a real host: `pages: 3, eventsSeen: 3,
   exhausted: true`.
2. **A control arm** (`replayCounterControl`) that opens a **second** pinned scan
   and requires the counter to rise. This is the arm that makes `replayCount: 1`
   non-constant *in the production oracle*, which it previously was not.
3. **A consumer-reachability field** (`consumerReach`) that records what the
   composed host actually wires to the service, rather than leaving the
   consumer question to prose.

**I falsified both new arms against the real boot**, by patching the built
`lib/` (then restoring it byte-identical, sha256 verified):

| mutation to `lib/history-plane.js` | `pageTraversal` | `replayCounterControl` |
|---|---|---|
| none (correct) | `pages:3, replayCount:1` | `afterFirst:1, afterSecond:2, controlHasTeeth:true` |
| **increment deleted** | `pages:3, replayCount:0` | `afterFirst:0, afterSecond:0, controlHasTeeth:false` |
| **pin removed** (re-observe per page) | `pages:3, replayCount:3` | `afterFirst:3, afterSecond:4, controlHasTeeth:true` |

So the strengthened probe catches both failure directions in a **real boot**: a
dead counter (`replayCount: 0`, `controlHasTeeth: false`) and a broken pin
(`replayCount: 3` = one per page, instead of 1).

I also re-ran the two unit-layer falsifications as named evidence rather than
leaving them as scratch output:
`falsify-01-pin-removed.txt` and `falsify-02-property-form.txt`.

---

## 6. The consumer question — the service has **NO** consumer

This is a negative result and I am reporting it as one.

| what I searched | result |
|---|---|
| `dailyHistory` across the repo, excluding `node_modules` and `lib/` | the plugin itself, the test file, `cordis.patch.yml` comments, `writers-plugin.ts` (a comment), and two qualification runners. **No production caller.** |
| `.history(` / `.recordFetch(` / `.recordSearch(` / `.untrusted(` / `.untrustedNotice` / `.dynamicTailBytes` outside tests and probes | **zero** hits |
| production importers of `history-plane.ts` / `web-provenance.ts` | only `history-plugin.ts` |
| `packages/dsh-ipython` for any history reference | **zero** hits (the only `store_history` string in the tree is a Jupyter kernel option in `broker.py`, unrelated) |
| a host-callback channel from a cell to the host | **none exists.** `BrokerReply` is `reply`; `BrokerEvent` is `kernel_exited` / `late_output` / `diagnostic` (`packages/dsh-ipython/src/protocol.ts:252-263`). A cell cannot call back into the host. |
| the `ipython` tool's parameters | exactly one, `code` (`packages/dsh-ipython/src/ipython-tool.ts`) |
| `KernelService` public surface for a history binding | `reconfigure`, `identityFor`, `runCell`, `currentEpoch`, `hasKernel`, `drainUnattributed`, `interrupt`, `restart`, `evict`, `close`, `listSessions` — **no history member** |
| model-facing tools named for history/provenance | **none** (`historyToolRegistered: []`, measured in the composed host) |

**So the precise statement is:** `ctx.dailyHistory` is a mounted service with a
provider, a service definition, and **no consumer**. The intended consumer named
in the M7 report — "the M3 `python_exec` / IPython cell, bound by the host" —
**does not exist in the tree.** `packages/dsh-ipython` has no history binding, no
host-callback protocol to carry one, and the model's `ipython` tool takes one
parameter and cannot reach the host context. The same absence applies to the
web-provenance half: stock `web-tool` never calls `recordFetch`, so no real fetch
is ever recorded.

I did **not** invent a caller to make the graph look connected.

**This is the unwired-module defect class** (`docs/GAPS.md` row 4), and it is a
*smaller* instance than instances 1 and 2: unlike `setLaunchPort` (where the
product was broken) or the missing `dsh.bundle` (where the package could never
reach the model), **every M7 gate is a statement about the plane's own behaviour,
and each is true.** The honest framing is: the mechanism is complete and correct;
the product does not yet call it. It is a gap in **reach**, not a false PASS.

**What IS proven about reachability:** the service is reachable **by a plugin**,
end to end, in a real boot. It is not reachable by the model or by a Python cell.
The gap between those two is the whole finding.

**Recommended fix, not done here** (it is outside my file ownership and would be
a fake): binding a consumer means the IPython cell path needs a host-callback
channel that does not exist today, which is an M3 design change, not an M7 edit.
Recording the absence is the honest alternative.

---

## 7. What is NOT proven

- **No live network, no paid provider, no real web page.**
  `live_provider_budget_authorized` is `false` and was never treated as true.
  Every provider is a fixture registered through the real `ctx.web` seams. The
  only real socket is the loopback HTTP server inside the WEB-05 test, started
  and torn down in the test. **No claim is made about any real URL, page, PDF or
  search result** — every one is fabricated.
- **The HTML→markdown converter and the PDF extractor are injected.** The real
  converter is turndown+gfm in `packages/web/tool-web/src/fetch.ts`, which is not
  a package export. WEB-03 proves the **raw/derived separation and failure
  behaviour**, not turndown's output. DSH ships no PDF extractor, so WEB-08
  proves the **classification** of extractor outcomes; the real streaming
  decompressor IS exercised against a real 64 MiB bomb.
- **HIS-07 is a property of this code, not of the system.** `authorityOf` and
  `capabilitiesFor` cannot be talked into granting capability. Whether a future
  consumer consults only `authorityOf` is not something M7 can assert — and
  today there is no consumer at all.
- **The boot is the canary home** (`D:\DSH\home\canary5`), with the
  `daily-candidate` profile installed as `daily`. The composition is real; the
  deployment is a canary, not a user's daily home.
- **The "~50 MB per-page replay" figure is a projection**, not a measured second
  run (§3.2b). The measured facts are 1 read and <1 MB.
- **The boot probe's traversal is 3 pages, not 100.** I strengthened it to be
  genuinely multi-page, but a freshly created session has 3 events. The
  **100-page** figure is measured in the unit test, at the persistence handle;
  the boot probe measures **3 pages with the counter pinned at 1** plus a control
  arm. Stated separately so the two are not conflated.
- **No machine-readable registry carries M7's 17 gates as PASS.**
  `qualification/specs/acceptance-spec.json` records all 112 cases `NOT_RUN`, and
  `qualification/gates.json` uses a different id scheme (104 gates, A/B/C/…/W01)
  that does not include HIS-/WEB-/ECO-04. **The M7 verdict lives only in prose**
  (`M7-history/FINDINGS.md`, `P9-history/FINDINGS.md`, this file). I did not edit
  either registry — both are owned elsewhere — but the root agent should decide
  whether the promotion path consumes `gates.json` and would therefore not see
  these gates.
- **`P9-history/` was written while I was working** (its `FINDINGS.md` appeared at
  03:08, and the test file was edited at 03:07:06). I verified the current state
  and the hashes I report; I did not verify P9's intermediate states.
- **`tsc` cleanliness is momentary.** Both configs exit 0 now, with zero
  diagnostics, but this tree is shared with concurrently-editing agents, so that
  result describes this instant.

---

## 8. Commands run, with exit codes

```
# tests -- final state, all mutations reverted
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/history-web.test.ts                       -> exit 0, 85 passed (85)

# type checks -- both required configs
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
                                                          -> exit 0, 0 diagnostics
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json
                                                          -> exit 0, 0 diagnostics

# build (proves lib/ matches source; came back byte-identical)
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json
                                                          -> exit 0

# real boot through the real profile resolver
cd /d/DSH/src/dsh-src
export DSH_HOME='D:\DSH\home\canary5'
node apps/cli/lib/bin.js --profile daily \
  --patch 'D:\DSH\work\dsh-native-daily\qualification\runners\verify-m7-history.patch.yml' --no-open
                                                          -> boot_exit=124 (web host does not
                                                             self-exit); probe written,
                                                             error:null, service present
node apps/cli/lib/bin.js --profile daily --dump-config    -> daily-history at row 591

# FALSIFICATION RUNS (scratch copies; all restored and sha256-verified)
#   1. all 5 sites -> ctx.sessionQuery          -> exit 1, 1 failed | 84 passed
#                                                  ONLY the plugin-caller test failed
#      evidence: falsify-02-property-form.txt
#   2. counter increment deleted (source)       -> exit 1, 3 failed | 82 passed
#   3. pin removed, continueScan re-observes    -> exit 1, 3 failed | 82 passed
#                                                  "expected 100 to be 1" x3
#      evidence: falsify-01-pin-removed.txt
#   4. readEvent scan option ignored            -> exit 1, 2 failed | 83 passed
#   5. lib/ increment deleted, real boot        -> replayCount:0, controlHasTeeth:false
#   6. lib/ pin removed, real boot              -> replayCount:3, pages:3
```

---

## 9. Files

**R11 evidence (new), `qualification/results/R11-history/`:**

- `FINDINGS.md` — this file
- `tests.txt` — the 85-test run (verbose, ANSI-stripped)
- `boot-probe.txt` — the real boot, service present, control arm green
- `falsify-01-pin-removed.txt` — pin falsification, `expected 100 to be 1`
- `falsify-02-property-form.txt` — property-form falsification, the one failing test
- `tsc-build.txt`, `tsc-check.txt` — exit 0, zero diagnostics

**Edited by R11 (my file only):**

- `qualification/runners/verify-m7-history.mjs` — strengthened: one-event-per-page
  bounded traversal, a replay-counter control arm, and a `consumerReach` field.
  sha256 `1907f49e69a45071ee345b288efa269c3d3a268664375d9cf7abe7eb390f847b`.

**NOT edited by R11:** `history-plane.ts` (`8219d34c…`), `history-plugin.ts`
(`8ba96bed…`), `web-provenance.ts` (`c2fa1d5d…`) and `history-web.test.ts`
(`daa81659…`) are byte-identical to what I received, verified after every
falsification run. No shared file (`cordis.patch.yml`, `package.json`), no
`docs/GAPS.md`, no file owned by another agent, and nothing in
`D:\DSH\src\dsh-src`.

**Cleanup:** all scratch files removed from `R11-history/`; the built `lib/` was
restored byte-identical after each falsification boot; port 3080 verified
**released** after every boot (`netstat` shows no listener); no orphan `dsh` or
`vitest` processes remain from this run.

---

## 10. The exact rows to add to `docs/GAPS.md`

I did **not** edit `docs/GAPS.md` (another agent owns it). Row 4 of the unwired
table and instance 6 already exist and already say this — **no new row is
required for the consumer finding.** The one row I would add is for the probe
weakness I found and fixed, since it is the same defect class the file documents:

```markdown
| 7 | The M7 boot probe's traversal was a single page while its comment claimed 100 | `verify-m7-history.mjs` opened with `openScan(maxEvents: 8)` and looped at `maxEvents: 1`. A freshly created session has ~3 events, so the first page exhausted the scan, the continuation loop never ran, and the probe recorded `pages: 1` — reproduced in both the M7 and P9 recordings. `pages: 1` cannot distinguish a pinned scan from a per-page re-observer, because no page 2 is ever taken, so `replayCount: 1` was unfalsifiable in the production oracle. | FIXED — traversal now pages one event at a time under `MAX_PAGES`, and a `replayCounterControl` arm opens a SECOND pinned scan and requires the counter to rise. Falsified against a real boot: deleting the increment gives `replayCount: 0, controlHasTeeth: false`; removing the pin gives `replayCount: 3` (one per page). Evidence: `qualification/results/R11-history/`. |
```
