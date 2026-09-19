# P9 — independent verification of M7 (history plane, web provenance)

**Date:** 2026-09-20
**Role:** P9 of 10, independent verification. The M7 agent's report was treated as a
CLAIM, not as evidence. Every claim below was re-derived from source and from
re-execution; the two that did not survive are named as such.
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (unmodified)
**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`. No commit was made.

## Headline

The M7 implementation is sound and its measurements are real — **claims 2, 3, 4 and 5
are CONFIRMED, several with falsification controls the original agent did not have.**
**Claim 1 is REFUTED as stated**: the `ctx.get` fix is correct and present, but the two
regression tests the agent said "pin it so it cannot come back" **do not reproduce the
failure**, and I measured that: with the property form restored at all five production
sites, the entire 84-test suite still passed. The bug the boot probe caught is real; the
test that was supposed to guard it was not guarding it. I added a test that does, and
measured it failing with the property form and passing with `ctx.get`.

**The service is production-wired but has NO consumer.** It is reachable in a real boot
(`dailyHistoryServicePresent: true`), and the row is in the resolved profile tree, but
nothing in the product calls `ctx.dailyHistory.history(caller)` or any of its other
methods. This is the unwired-module defect class. Details in §4.

## 1. Test count — re-run, confirmed, with one addition

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/history-web.test.ts
```

| run | result | exit |
|---|---|---|
| M7 as recorded | 84 passed | 0 |
| **P9 re-run, unmodified source** | **84 passed** | **0** |
| **P9 final, with the added regression test** | **85 passed** | **0** |

The recorded `tests.txt` is **not stale**: 84/84 reproduced exactly. My final number is
85 because I added one test (§3.1). Evidence: `tests.txt` (ANSI-stripped), `boot-probe.txt`.

Per-gate test counts, counted from the run rather than from the notes — all match the
M7 report exactly:

| gate | tests | gate | tests | gate | tests |
|---|---|---|---|---|---|
| HIS-01 | 9 | WEB-01 | 3 | WEB-06 | 4 |
| HIS-02 | 6 | WEB-02 | 3 | WEB-07 | 5 |
| HIS-03 | 7 | WEB-03 | 5 | WEB-08 | 7 |
| HIS-04 | 3 | WEB-04 | 3 | ECO-04 | 4 |
| HIS-05 | 4 | WEB-05 | 8 | | |
| HIS-06 | 2 | HIS-07 | 3 | HIS-08 | 3 |

## 2. Per-gate status, and the assertion I actually checked

I did not re-derive all 85 assertions. For each gate I read the load-bearing assertion
and, where the gate's whole claim rests on one mechanism, I falsified that mechanism and
confirmed the test fails. "Falsified" below means: I broke the mechanism in a scratch
copy, watched the gate FAIL, and restored the file to its recorded sha256.

| gate | status | the assertion I checked, and how |
|---|---|---|
| HIS-01 | **PASS** | `authorizeHistoryRead` decides BEFORE `headerOf` is consulted for a foreign id, so refusal and absence are separate codes. Read at `history-plane.ts:508-524`. Refusal is `HISTORY_SESSION_UNAUTHORIZED`, absence `HISTORY_SESSION_ABSENT`. |
| HIS-02 | **PASS** | `continueScan` reads the watermark from the CURSOR and events from the pinned observation (`history-plane.ts:575-596`); it calls `#takeObservation` nowhere. A superseded cursor throws `HISTORY_WATERMARK_SUPERSEDED`. Confirmed by reading, and by the FALSIFY run in §3.2 which re-observed per page and broke it. |
| HIS-03 | **PASS** | Oversized event returns `kind: 'segments'` with `totalBytes`, `digest`, and `recovery: 'authorized-refetch'`; segment list bounded by `SEGMENT_COUNT_BUDGET` (`history-plane.ts:687-703`). The returned object has no `event` field on that branch. |
| HIS-04 | **PASS — measured, and FALSIFIED twice** | See §3.2. Both oracles have teeth: the counter test fails `expected 100 to be 1` when the pin is removed, and fails `expected +0 to be 1` when the increment is deleted. |
| HIS-05 | **PASS** | `visibilityLedger` is constructed FROM session-query's own `SessionEventRecord[]` (`history-plane.ts:77-80`); `stored` is `SessionEventSurface` imported from session-query, not a local re-classification. Confirmed by import list. |
| HIS-06 | **PASS** | Versioned memory: both versions persist, `supersedes` links them, each keeps its own `source`. Read in source; the 2 tests assert it. |
| HIS-07 | **PASS** | `authorityOf` reads `author` only; the guard throws by design. The claim is scoped to this code, which §6 states. |
| HIS-08 | **PASS** | Rebuild is proven against the real SQLite FTS5 backend after deleting its file (test mounts `SqliteSessionQueryEngine`). |
| WEB-01 | **PASS** | `truncated: true` → `partial` + a `provider-acquisition` gap with `recovery: 'refetch'`; the vocabulary has no local-recovery member (asserted as a vocabulary guard). |
| WEB-02 | **PASS** | Uncursored top-10 is `mayBeMore: 'unknown'`; only a seam cut is `'true'`. |
| WEB-03 | **PASS** | A failed/empty conversion returns NO derived body — it does not fall back to raw HTML. |
| WEB-04 | **PASS** | Refetch creates a new observation; old hash/time/etag survive; change detected from ETag OR body hash; no "current body for this url" lookup exists. |
| WEB-05 | **PASS** | Four separate refusals driven against a real loopback HTTP server that answers 200 to a `Range` request (the server is started in the test, torn down in `afterEach`). |
| WEB-06 | **PASS** | Quote located at real byte offsets inside the captured artifact; a snippet is refused as `snippet-is-not-full-text`; a non-occurring quote is `unsupported`, not approximately matched. |
| WEB-07 | **PASS** | Injection attempts recorded as findings, text passes through verbatim; the untrusted record has no field that could carry authority; the notice is asserted EQUAL to DSH's own string. |
| WEB-08 | **PASS** | `empty` is an extractor outcome with `unknown` coverage; decode errors and budget stops are separate; a real 64 MiB deflate bomb is stopped at the bound. |
| ECO-04 | **PASS** | Assembled prefix is byte-identical across three cells that change only budget/variables. |

## 3. The five claims, adjudicated

### 3.1 Claim 1 — `ctx.get` fix and the two regression tests: **REFUTED as stated**

**The fix itself is CONFIRMED.** `ctx.sessionQuery` appears in my files only inside
comments and strings. Every real read is `ctx.get('sessionQuery')`:
`history-plane.ts:184`, `:843`, `:901`; `history-plugin.ts:111`, `:127`. `inject` is
`[]`. The built `lib/` carries the same form, so the production artifact matches source.

**The regression claim is REFUTED.** The M7 report says two tests "pin it" so the bug
"cannot come back", and specifically that the test mounts "through its real fiber"
because "a bare `ctx.isolate()` would not reproduce it". The agent was right that a bare
isolate does not reproduce it — but the test it wrote does not reproduce it either, and
I measured that rather than arguing it:

```
# all five production sites reverted to ctx.sessionQuery, source only:
vitest run src/history-web.test.ts   ->  84 passed (84), exit 0
```

The mechanism, which I proved with an isolated probe rather than inferring:

| probe | result |
|---|---|
| `apply()` body reads the property, plugin fiber, no inject | **throws** `cannot get property "sessionQuery" without inject` |
| nested `ctx.isolate()` from that fiber | **throws** |
| after the fiber is ACTIVE, a service method reads `this.ctx.sessionQuery` | **throws** |
| **called from the ROOT context** (the shape both M7 tests use) | **does NOT throw** |

Why: the inject check is evaluated against the **CALLER's** fiber, not the plugin's.
`ctx.get(name)` returns a traceable proxy that captures the calling context
(`vendor/cordis/src/utils.ts:165-197`), and the check falls through to
`ctx.reflect.get(prop, false)` only when `!ctx.fiber.runtime`
(`vendor/cordis/src/reflect.ts:152`). The root context has `runtime === null`, so it
short-circuits. A live instrumentation of `available()` inside the real rig confirmed
it: `{"propThrew":false,"propIsUndef":false,"runtimeNull":true,"parentNull":false}`.
The plugin's own fiber is a child of root, so `parentNull:false, runtimeNull:true` is
exactly the short-circuit.

So the M7 comment at `history-web.test.ts:384-387` — "The condition is reproduced
through the REAL plugin fiber, because that is where the inject check lives" — is
**wrong on its own terms**: mounting through a real plugin fiber is necessary but not
sufficient; the CALL must also come from a non-root fiber, and both tests call from root.

**What I changed (my file, additive):**

1. Added a regression test that calls from a **plugin caller** — a real plugin whose
   `apply` does `c.get('dailyHistory')` and then `service.history(caller)` +
   `openScan`. MEASURED teeth: with the property form restored it **FAILS** with
   `cannot get property "sessionQuery" without inject`; with `ctx.get` it passes.
2. Corrected the false comment on the old test rather than deleting the test — it still
   asserts something true (the service mounts through the real entry and serves an
   authorized read), it just does not guard the inject bug. The correction names the
   measurement and points at the new test.

**The production oracle does have teeth**, which is the good news the report deserved
credit for. I patched the built `lib/` to the property form and ran the real boot:

```
M7-HISTORY: {"dailyHistoryServicePresent":true,"sessionQueryServicePresent":true,
"historyAvailable":false, ... ,
"error":"Error: cannot get property \"sessionQuery\" without inject"}
```

`lib/` was then restored byte-identical (sha256 verified). Evidence:
`boot-probe-propertyform.txt`.

**Sharpened statement of the finding:** the boot probe is the only oracle in M7 that
catches this class of defect. The unit suite could not, because every unit test calls
from the root context. That is a stronger argument for the boot probe than the report
made — and a weaker claim for the unit tests than the report made.

### 3.2 Claim 2 — HIS-04 measures replays two ways: **CONFIRMED, and both arms falsified**

**(a) The counter is incremented by the real read path.** `#takeObservation`
(`history-plane.ts:713-719`) is called from exactly ONE place, `openScan:536`, and
nowhere in `continueScan`. The counter increments only when the observation reports
`materializedFullLog`, which the production observer sets to `true` at `:879` from the
single `observeSession` lease. So `total === 1` for a 100-page traversal is a
consequence of the pin, not of a constant.

**Teeth, measured by falsification:**
- Delete the increment → `measures ONE full-log materialization` FAILS: `expected +0 to be 1`.
- Make `continueScan` re-observe each page (inject `#takeObservation` there) → FAILS
  `expected 100 to be 1` on two tests, and the control arm still passes, so the failure
  is the traversal cost and not a broken fixture.

**The control arm has teeth.** `counts a full-log materialization when the plane is
asked for a fresh scan` asserts 1 then 2 after `closeScan` + reopen
(`history-web.test.ts:837-841`). I verified it is an independent scan, not a second page
of the first. This is the arm that makes `1` non-constant.

**(b) The byte measurement is real physical I/O, not a computed constant.**
I traced the path end to end rather than trusting the test's shape:

```
sessionQuery.readEvent -> SessionQueryEngine._readEvent  (index.ts:369)
  -> this._corpus.load(...)                              (index.ts:370)
    -> inspectPersisted -> readColdSessionLog            (corpus.ts:280)
      -> persistence.open(id,'read'); handle.read(0, undefined)   (cold-read.ts:40-42)
```

`handle.read(0, undefined)` is an unbounded read of the whole logical log
(`session-persistence-jsonl/src/storage.ts:118-158`), whose backing is
`readStableJsonlFile` → `fs.readFile` (`generation.ts:252-267`). The test's
`CountingJsonl extends JsonlSessionPersistence` overrides `open()` and wraps the REAL
`handle.read` returned by `super.open`, counting calls and summing
`canonicalEventBytes(event).byteLength` over `result.events` — i.e. bytes that actually
came back from the storage handle. The assertions are `logReads === 1`,
`oneLog > 400_000`, `bytesRead < 1_000_000`, and `bytesRead * 100 > 40_000_000`
(`history-web.test.ts:765-773`). This is a physical measurement with a stated contrast.

**One honest caveat on the arithmetic:** the "~50 MB for a per-page replay" figure is a
projection from the measured `oneLog` (500 KB × 100), not a second measured run. The
measured facts are: 1 read, and bytes < 1 MB for a traversal whose per-page cost would
be ~500 KB × 100 pages. The projection is sound and is labelled as a projection in the
test comment; it is not presented as a measurement.

### 3.3 Claim 3 — the correction to its own brief: **CONFIRMED**

The brief's premise was that `readEvent` returns the full event "plus a bounded window".
The agent corrected this to: correct, but **O(log)** per call, because
`readEvent` → `_readEvent` → `_corpus.load` → `readColdSessionLog` reads the complete
log. Confirmed in source at the four call sites listed in §3.2(b). The fix — a `scan`
option so an event read slices the already-pinned observation — is at
`history-plane.ts:661-666`, and its test measures the contrast directly:
5 pinned reads cost **0** additional log reads, 3 unpinned reads cost **3**
(`history-web.test.ts:691-706`). That is a stronger form of the correction than the
report gave it: the cost is not described, it is counted in both directions.

### 3.4 Claim 4 — the upstream observation-cache defect: **CONFIRMED (independently, in source)**

Re-verified the two halves myself:
- the key comparison `cached.persistence !== persistence || cached.revision !== revision`
  at `packages/session-query/session-query/src/observation.ts:209`, fed by
  `const persistence = this.ctx.get('sessionPersistence')` at `observation.ts:106`;
- `ctx.get` → `getTraceable(this.ctx, ...)` (`reflect.ts:233-235`) → `createTraceable`
  → `return new Proxy(value, ...)` (`utils.ts:124`, `utils.ts:165-166`), a fresh object
  per call.

So the identity half of the key can never match. The M7 measurement (6 observations,
cacheSize 32, stable revision → 6 full log reads) is reproduced by its own test, which I
ran: `reuses the underlying prepared observation lease across scans of the same session`
passes and asserts `logReads - beforeRepeated === 3` for 3 repeats.

**It is recorded in the right place.** `docs/GAPS.md` **G-SEAM-23** (added by commit
`ebc8c4f`) states the defect, both source citations, the measurement, the escape
(`proxy[symbols.original]`), and that this project is not exposed because the history
plane pins its own observation. I did not edit that file (another agent owns it).

### 3.5 Claim 5 — reuse, no second store, no prohibited wrappers: **CONFIRMED**

| claim | how I checked | result |
|---|---|---|
| reads go through `ctx.sessionQuery` | enumerated every call in the production wiring | exactly four: `filterSessions` (`:195`, header-only authz probe), `observeSession` (`:856`), `readEvent` (`:884`), `readSession` (`:908`). No fifth. |
| imports `buildSessionEventRecords` + `SessionEventSurface` rather than re-classifying | read the import block (`:58-65`) and the `visibilityLedger` construction | confirmed; `stored` is session-query's own classification |
| `eventAt` / `snapshotEvents` / `ownEvents` only in a comment | `grep -n` over all four of my files | **exactly two hits, both comment lines** (`history-plane.ts:47-48`), in the header that records why they are not used. No code occurrence. |
| no second store, no DB, no owned log | listed every import of all three production files | `@deepseek-ai/cordis`, `dsh-session`, `dsh-session-query`, `dsh-web`, `node:buffer`, `node:crypto`, `node:zlib`. **No sqlite, no database, no fs write path, no `mkdirSync`.** |

The structural test `does not expose the raw sessionQuery service from the plane`
(`history-web.test.ts:438-449`) asserts the plane's own property list matches no
`/service|query|engine|store|corpus|observe/i` and that `.sessionQuery` is `undefined`.
That is a real structural guard, and I verified it is not vacuous by reading the
property list it enumerates (`#caller`, `#corpus`, `#observe`, `#readFullEvent`,
`#replays`, `#generation`, `#openScans` — all private, none matching).

## 4. Production reachability and the consumer question

### 4.1 The service IS reachable in a real boot — CONFIRMED

Re-ran the probe through the real profile resolver, not by reading the patch:

```
cd /d/DSH/src/dsh-src
export DSH_HOME='D:\DSH\home\canary5'
node apps/cli/lib/bin.js --profile daily \
  --patch 'D:\DSH\work\dsh-native-daily\qualification\runners\verify-m7-history.patch.yml'
```

Result (`boot-probe.txt`, boot_exit=124 is the web host not exiting on its own, not a
boot failure — the probe line is written before it):

```json
{"dailyHistoryServicePresent":true,"sessionQueryServicePresent":true,
 "historyAvailable":true,
 "selfRead":{"eventCount":3,"exhausted":true,"watermarkSeq":2,"generation":1},
 "foreignReadRefused":true,"foreignRefusalCode":"HISTORY_SESSION_UNAUTHORIZED",
 "pageTraversal":{"pages":1,"replayCount":1},
 "provenanceRecord":{"completeness":"partial","gapRecovery":["refetch"]},
 "untrustedContent":{"trust":"untrusted-data","findingCount":2,
   "findingIds":["imperative-command","authority-claim"]},
 "error":null}
```

The refusals are the load-bearing part and they are present: a foreign-workspace read is
REFUSED with `HISTORY_SESSION_UNAUTHORIZED`, not answered with an empty page.

**Both recorded traps were checked, and neither bites here:**

- *`cordis.patch.yml` replaces the whole `config`, it is not a deep merge.* The
  `daily-history` row contributes **no `config` block at all** (`cordis.patch.yml:120-123`),
  so there is nothing to truncate. This trap does not apply to this row.
- *`inject` is a readiness gate, so a probe omitting a service from `inject` runs early
  and reports a false absence.* The probe declares `inject = ['sessionController']`, and
  it reads `dailyHistory` via `ctx.get` (inject-free) but only AFTER awaiting
  `sc.create(...)`, i.e. after activation has settled. Verified in the resolved tree that
  the ordering is safe: `--dump-config` puts `daily-history` at position 591 and the
  probe row at 624, so the probe activates after the service row.

I did **not** need to edit `cordis.patch.yml` or `package.json`. Both already carry the
M7 additions (`daily-history` insert row; `exports["./history"]`), and I confirmed the
`./history` export resolves to a real built file (`lib/history-plugin.js` exists and
contains `ctx.get('sessionQuery')`). **No shared file was modified by P9.**

### 4.2 Does the service have a real consumer? **NO — it is unwired**

This is the answer the task asked for, and it is negative. I searched exhaustively:

| what I searched | result |
|---|---|
| `dailyHistory` across the repo, excluding `node_modules` and `lib/` | the plugin itself, the test file, `cordis.patch.yml` (comments), and two qualification runners. **No production caller.** |
| any `.history(`, `.recordFetch(`, `.recordSearch(`, `.untrusted(`, `.untrustedNotice`, `.dynamicTailBytes` outside tests/probes | **zero** |
| production importers of `history-plane.ts` / `web-provenance.ts` | only `history-plugin.ts`. Nothing else. |
| `packages/dsh-ipython` (the claimed M3 consumer) for any history reference | **1 hit, and it is `"store_history": True` in `broker.py`** — a Jupyter kernel option, unrelated |
| any host-callback / native-tool channel from a cell to the host | the broker protocol has **no such message type**: `BrokerReply` is `reply`, `BrokerEvent` is `kernel_exited` / `late_output` / `diagnostic` (`protocol.ts:252-263`). A cell cannot call back into the host. |
| `tools.ts` (the model-facing tool surface) for a history tool | no `history`/`provenance` reference at all; the registered tools are the work tools |
| stock `dsh-tool-web` fetch path for a provenance recorder | no `provenance` / `recordFetch` / `dailyHistory` reference — stock `web_fetch` does not record provenance |

**So the precise statement is:** `ctx.dailyHistory` is a mounted service with a
service definition, a provider, and **no consumer**. The intended consumer named in the
M7 report — "the M3 `python_exec` / IPython cell, bound by the host" — does not exist in
the tree. `packages/dsh-ipython` has no history binding, no host-callback protocol to
carry one, and the model's `ipython` tool takes exactly one parameter (`code`) and
cannot reach the host context. I did **not** invent a caller to make the graph look
connected.

**What IS proven about reachability, stated precisely:** the service is reachable *by a
plugin*, end to end, in a real boot — which is what the boot probe demonstrates, and what
my new plugin-caller test demonstrates in the unit layer. It is not reachable *by the
model* or by a Python cell. The gap between those two is the whole of the finding.

**This is the G-FIX-04 / "unwired module" defect class**, and it is a *smaller* instance
than the ones `docs/GAPS.md` records: unlike `setLaunchPort` (where the product was
broken) or the missing `dsh.bundle` (where the package could never reach the model), M7's
gates do not depend on a consumer existing — every HIS/WEB gate is a statement about the
plane's own behaviour, and each is true. The honest framing is: **the mechanism is
complete and correct; the product does not yet call it.**

**Recommended fix (not done here — it is outside my file ownership):** either bind a
consumer, or record the absence. Binding one means the IPython cell path needs a
host-callback channel that does not exist today, which is an M3 design change, not an M7
edit. Recording it is one GAPS row. I have drafted the row in §7.

## 5. What I strengthened

1. **A regression test with measured teeth** for the inject bug (§3.1), replacing a
   guard that I demonstrated did not guard. This is the single most valuable change here:
   the M7 report's central "the boot probe caught what 80 unit tests missed" narrative
   was right, but the follow-up test was itself an example of the same weakness.
2. **Falsification controls** for HIS-04 in both directions (undercount, and remove the
   pin), which the M7 report did not have. Both arms confirmed.
3. **Corrected a false comment** in the test file rather than leaving an over-claim in
   place — the project's recurring failure mode is exactly this.
4. **A negative result, stated as one**: the consumer does not exist.

## 6. What is NOT proven

- **No live network, no paid provider, no real web page.** `live_provider_budget_authorized`
  is `false` and was never treated as true. Every provider in these tests is a fixture
  registered through the real `ctx.web` seams. The only real socket is the loopback HTTP
  server in the WEB-05 test, started and torn down inside the test. No claim is made about
  any real URL, page, PDF, or search result — every one is fabricated.
- **The HTML→markdown converter and the PDF extractor are injected.** The real converter
  is turndown+gfm inside `packages/web/tool-web/src/fetch.ts`, which is not a package
  export. WEB-03 therefore proves the raw/derived separation and the failure behaviour,
  **not** turndown's own output. DSH ships no PDF extractor, so WEB-08 proves the
  classification of extractor outcomes; the real streaming decompressor IS exercised
  against a real 64 MiB bomb.
- **HIS-07 is a property of this code, not of the system.** `authorityOf` and
  `capabilitiesFor` cannot be talked into granting capability. Whether some future
  consumer consults only `authorityOf` is not something M7 can assert.
- **The `daily` profile boot is the canary home** (`D:\DSH\home\canary5`), not a user's
  daily home, and it is `daily-candidate` installed as `daily` (per
  `M12-deliverable-surface/surface.json`). The composition is real; the deployment is a
  canary.
- **The `~50 MB` per-page-replay figure is a projection**, not a measured second run
  (§3.2b).
- **The acceptance spec is a pristine baseline.** `qualification/specs/acceptance-spec.json`
  records **all 112 cases as `NOT_RUN` with empty `evidence`** — including HIS-01..08,
  WEB-01..08 and ECO-04. That file is untracked and unmodified, so it is not a stale
  record of M7; it is simply not the place this project writes gate outcomes. The M7
  gates are absent from `qualification/gates.json` too (which uses the A/B/C/.../W01 id
  scheme, 104 gates). **So there is no machine-readable registry in which M7's 17 gates
  appear as PASS.** The verdict lives only in `qualification/results/M7-history/FINDINGS.md`.
  If the promotion decision consumes `gates.json`, M7's gates are invisible to it. I did
  not edit either file — both are owned elsewhere — but the root agent should decide.
- **`tsconfig.check.json` exits 0 in MY run**, contrary to the M7 report which recorded
  exit 2 due to another agent's concurrent file. Both configs are clean now (see §8).
- **The boot probe proves the service is mounted and serves an authorized read.** It does
  **not** prove any model-facing path reaches it, because none does (§4.2).

## 7. The exact table rows to add to `docs/GAPS.md`

I did not edit `docs/GAPS.md` (another agent owns it). Paste the following. The first row
belongs in the "unwired" table at the top of *The defect class this project kept
producing*; the second and third belong in the numbered list beneath it.

```markdown
| 4 | `ctx.dailyHistory.history(caller)` — zero production consumers | the M7 history plane is mounted in the composed profile and serves authorized reads, but nothing in the product calls it: no model-facing tool, no Python-cell binding, and the IPython broker protocol has no host-callback message type that could carry one | OPEN — mounted and correct, not yet called; the gates are statements about the plane and none depends on a consumer |
```

```markdown
4. `ctx.dailyHistory` — the M7 history plane. Every gate (HIS-01..08, WEB-01..08,
   ECO-04) is a statement about the plane's own behaviour and each is true, so the
   absence of a consumer is a gap in REACH, not a false PASS. The intended consumer
   named in `qualification/results/M7-history/FINDINGS.md` — the M3 `python_exec`
   cell, "bound by the host" — does not exist in the tree: `packages/dsh-ipython` has
   no history binding, its broker protocol carries only `reply` /
   `kernel_exited` / `late_output` / `diagnostic` (`src/protocol.ts:252-263`), and
   the `ipython` tool's only parameter is `code`. The same absence applies to the
   web-provenance half: stock `dsh-tool-web` does not call `recordFetch`, so no real
   fetch is ever recorded. Binding a consumer is an M3-side design change (a cell
   needs a host-callback channel), not an M7 edit.
```

```markdown
5. **The M7 regression test for the inject bug did not guard it, and that was
   measured, not argued.** With `ctx.sessionQuery` restored at all five production
   sites (`history-plane.ts:184,843,901`; `history-plugin.ts:111,127`) the full
   suite still passed 84/84. The inject check is evaluated against the CALLER's
   fiber: `ctx.get` captures the calling context (`vendor/cordis/src/utils.ts:165-197`)
   and `reflect.ts:152` short-circuits with `if (!ctx.fiber.runtime) return
   ctx.reflect.get(prop, false)`, so a call from the ROOT context never throws
   however the plugin reads the service. Both M7 tests called from root. The
   boot probe DOES catch it (measured: `historyAvailable:false` with that exact
   error). Fixed in P9 by adding a test that calls from a plugin caller — measured
   to fail with the property form and pass with `ctx.get`. **Lesson: "the test
   mounts through a real fiber" is not the same as "the test reproduces the
   failure", and only a falsification run distinguishes them.**
```

## 8. Commands run, with exit codes

```
# tests -- M7 source, unmodified
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/history-web.test.ts                     -> exit 0, 84 passed (84)

# tests -- P9 final, with the added regression test
vitest run src/history-web.test.ts                     -> exit 0, 85 passed (85)

# type checks -- both required configs, P9 final
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
                                                       -> exit 0 (no diagnostics)
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json
                                                       -> exit 0 (no diagnostics)

# real boot through the real profile resolver
cd /d/DSH/src/dsh-src
export DSH_HOME='D:\DSH\home\canary5'
node apps/cli/lib/bin.js --profile daily \
  --patch 'D:\DSH\work\dsh-native-daily\qualification\runners\verify-m7-history.patch.yml' --no-open
                                                       -> boot_exit=124 (web host does not
                                                          self-exit); probe line written,
                                                          error: null, service present

# falsification runs (scratch copies, all restored and sha256-verified)
#   counter increment deleted          -> HIS-04 FAILS  expected +0 to be 1
#   continueScan re-observes per page  -> HIS-04 FAILS  expected 100 to be 1
#   all 5 sites back to property form  -> 84/84 PASS (the refuted claim)
#   built lib back to property form    -> real boot FAILS  historyAvailable:false
#   new plugin-caller test vs property form -> FAILS with the inject error
```

## 9. Files

**P9 evidence (new):**

- `qualification/results/P9-history/FINDINGS.md` — this file
- `qualification/results/P9-history/tests.txt` — 85-test run, ANSI-stripped
- `qualification/results/P9-history/boot-probe.txt` — the real boot, service present
- `qualification/results/P9-history/boot-probe-propertyform.txt` — the falsification
  boot that proves the boot oracle has teeth
- `qualification/results/P9-history/tsc-build.txt`, `tsc-check.txt` — exit 0, no diagnostics

**Edited by P9 (my file only, additive):**

- `packages/dsh-daily-work/src/history-web.test.ts` — added
  `reads from a PLUGIN caller, the fiber the boot failure actually hit` (84 → 85 tests),
  and corrected the false comment on the pre-existing inject test. **No assertion was
  weakened, no test deleted or skipped, no N lowered.**

**NOT edited by P9:** `history-plane.ts` and `history-plugin.ts` are byte-identical to
what I received (sha256 verified after every falsification run:
plane `8219d34c029df53392fdacd21bfabfb23291068cc09df0332e2a390a45059ba6`,
plugin `8ba96bedec7cf44ef3c673dc6bc2fabdf70da7addf87571c62ab391a9cfe985b`).
No shared file (`cordis.patch.yml`, `package.json`), no `docs/GAPS.md`, no file owned by
another agent, and nothing in `D:\DSH\src\dsh-src`.

**Cleanup:** all scratch probes (`.p9-*.test.ts`) deleted; no orphan `dsh`/`vitest`
processes remain; the built `lib/` was restored byte-identical after the falsification
boot.
