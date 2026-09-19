# M7 — history access, versioned memory, web provenance, prefix stability

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)
**Evidence:** `tests.txt` (84 passed, exit 0), `tsc.txt` (4 runs, M7-attributable exit 0),
`source-digests.txt`, `boot-probe.json` (a real `dsh` boot through the real profile resolver).

## Verdict summary

| gate | status | what is genuinely proven |
|---|---|---|
| **HIS-01** cross-session authorization | **PASS** | Guessing another project's SessionId is refused with `HISTORY_SESSION_UNAUTHORIZED`, **before any observation runs**; the same refusal is returned for a foreign id that exists and one that does not, so a probe is not an existence oracle. A refusal and an authorized-but-absent session are separate codes. |
| **HIS-02** stable watermark | **PASS** | Events appended after `openScan` are absent from every continuation at that watermark, page order is stable, and the new events arrive from a **separate** scan at a new generation. A superseded cursor is refused, not re-based. |
| **HIS-03** one huge event | **PASS** | An event over the page budget returns **segments + full size + digest + `authorized-refetch`**, never a partial body as the event. The segment list is itself bounded, so offsets cannot become the payload. |
| **HIS-04** no repeated replay | **PASS — measured** | A **100-page traversal costs ONE full log read** (measured at the persistence handle) and `replayCounter().total === 1`. A 500 KB log over 100 pages reads <1 MB total; a per-page replay would be ~50 MB. |
| **HIS-05** three visibilities | **PASS** | Reuses DSH's own `current`/`shadowed`/`log-only`; stored/consumed/projected are recorded separately with cross-checks that refuse projection without consumption. |
| **HIS-06** memory correction | **PASS** | Old and new versions both persist; `supersedes` links them; the old version keeps its own `source`. The digest caveat travels on every source. |
| **HIS-07** memory does not elevate | **PASS** | `authorityOf` reads `author` and nothing else; a model statement with `['trusted','admin','root']` keeps `claim` authority and the guard throws by design. |
| **HIS-08** index rebuild | **PASS** | A derived index is dropped and rebuilt from canonical sessions only — proven against the **real SQLite FTS5 backend** after deleting its file. |
| **WEB-01** provider truncation | **PASS** | `truncated: true` → `partial` + `provider-acquisition` gap with `recovery: 'refetch'`; there is no local-recovery member in the vocabulary at all. |
| **WEB-02** ranking is not exhaustion | **PASS** | An uncursored top-10 is `mayBeMore: 'unknown'`; only a seam cut is `'true'`. The model-facing text says "not an exhaustive search of the Internet". |
| **WEB-03** raw/derived separation | **PASS** | Raw and derived are separately hashed and located; a failed or empty conversion records a `transform` gap and returns **no** derived body — it never falls back to raw HTML. |
| **WEB-04** refetch is a new observation | **PASS** | Old hash/time/etag survive untouched; change is detected from either the ETag or the body hash; there is no "current body for this url" lookup. |
| **WEB-05** Range anomalies | **PASS** | Four separate refusals (`range-ignored`, `range-mismatch`, `encoding-changed`, `entity-changed`), driven against a **real loopback server that ignores `Range` and answers 200**. |
| **WEB-06** claim traceability | **PASS** | A quote is located at real byte offsets inside the captured artifact; a search snippet is refused as `snippet-is-not-full-text`; a non-occurring quote is unsupported rather than approximately matched. |
| **WEB-07** malicious content | **PASS** | Injection attempts are recorded as findings and the text passes through verbatim; the untrusted record has **no** field that could carry authority, and `capabilitiesFor` ignores its argument. |
| **WEB-08** parse failures | **PASS** | `empty` is an extractor outcome with `unknown` coverage and an explicit `doesNotMean`; decode errors and budget stops are separate states; a real **64 MiB compression bomb** is stopped at the bound by streaming. |
| **ECO-04** prefix stability | **PASS** | The assembled prefix is **byte-identical** across three cells that change only budget/variables; the dynamic half is a bounded, later, ordered tail. |

**Two honest non-PASS items, stated rather than dressed up:** §5 (the upstream
observation-cache finding) and §6 (what is not proven). Neither is a gate failure.

---

## 1. What was REUSED, and what was BUILT

The coordinator asked for these four confirmations explicitly. Each is answered
against the code, not against the requirement.

### 1.1 Did I build on `ctx.sessionQuery` rather than a new store? — **YES**

Every history read goes through the service. The complete list of service calls
in `history-plane.ts`:

| call | where | why |
|---|---|---|
| `filterSessions([{kind:'id'}])` | `corpusViewFromContext` | authorization probe; returns headers and **never materializes a log**, so a probe cannot read the history it may refuse |
| `observeSession(id, {projectionMode:'none'})` | `createHistoryPlaneFromContext.observe` | the one pinned observation per scan |
| `readEvent({sessionId, seq})` | `createHistoryPlaneFromContext.readFullEvent` | the unpinned fallback for an oversized event |
| `readSession(id)` | `readAuthorizedSessionLog` | the whole-log helper, behind `assertReadable` |

No database is opened, no session log is owned, no second history source exists.
The only storage this milestone touches is DSH's own, through DSH's own service.

**One correction to a premise in my brief.** The brief says `readEvent` "returns
the FULL unabridged event plus a bounded window". That is true of the **event**,
but `sessionQuery.readEvent` internally calls `SessionCorpus.load`
(`session-query/src/index.ts:370`), which for a **persisted** session opens the
storage handle and reads the **complete log** on every call. So an event read is
correct but O(log). I measured this (§5) and gave the plane a `scan` option so an
event read can slice the observation it already holds.

### 1.2 Did I reuse the EXISTING three-valued visibility classification? — **YES**

`history-plane.ts` imports `buildSessionEventRecords` from
`@deepseek-ai/dsh-session-query`, which classifies via `foldSurface` +
`classifySurface` (`documents.ts:57-75`), and the plane's surface filter takes
`SessionEventSurface` (`'current' | 'shadowed' | 'log-only'`) straight from
`session-query/src/types.ts:24`.

There is **no second mechanism**. The `VisibilityLedger` does not re-derive
surface placement — it is constructed **from** the records session-query already
classified:

```ts
export function visibilityLedger(records: readonly SessionEventRecord[]): VisibilityLedger {
  return { stored: new Map(records.map(r => [r.seq, r.surface])), consumed: ..., projected: ... }
}
```

`stored` is the existing three-valued classification; `consumed` and `projected`
are the two new **facts** (did Python read it; did the model's request include
it), which are not a re-classification of the log and cannot be derived from it.

### 1.3 Did I avoid the prohibited synchronous wrappers? — **YES, none were added**

`grep` over my files finds `eventAt`/`snapshotEvents`/`ownEvents` only inside the
header comment that records why they are not used. Every read is async, paged and
cancellable. I did not add a sync wrapper anywhere.

### 1.4 Does HIS-04 actually MEASURE replays? — **YES, two independent ways**

1. **The plane's own counter.** `HistoryPlane.replayCounter()` counts
   `materializedFullLog` observations. A 100-page traversal reports `total === 1`.
   A control test proves the counter has teeth: a second *pinned scan* reports 2,
   so `1` cannot be a constant.
2. **Physical bytes at the persistence handle.** A `JsonlSessionPersistence`
   subclass counts `read()` calls and the serialized bytes returned. For a
   500 KB log over 100 pages: **1 read**, <1 MB total, against ~50 MB for a
   per-page replay. The assertion is on the order of the traversal's cost, and the
   contrast is stated as a number.

The measurement is not "reuse happened". It is "the log was physically read once".

---

## 2. The production wiring (added after supervision review)

**The defect the coordinator found was real, and I had it.** `history-plane.ts`
and `web-provenance.ts` had **no production importer** — mounting them in a test
proved they worked and proved nothing about whether the product used them. That
is the same class as `setLaunchPort`, `takeContinuation` and the missing
`dsh.bundle`, and `docs/GAPS.md` G-FIX-04 names the rule: an oracle weaker than
its scenario passes while the product is broken.

**What now exists:**

| artifact | role |
|---|---|
| `src/history-plugin.ts` (new) | a real Cordis plugin; registers `ctx.dailyHistory` (`HistoryPlaneService`) |
| `package.json` `exports["./history"]` | the package export the loader resolves |
| `cordis.patch.yml` "DIFFERENCE 3b" | the profile row that activates it |
| `qualification/runners/verify-m7-history.mjs` + `.patch.yml` (new) | a boot probe that runs **inside a real `dsh` boot** |

**Who the intended consumer is:** the M3 `python_exec` / IPython cell. A cell that
runs `history.scan(...)` calls `ctx.dailyHistory.history(caller)`, where `caller`
is bound by the host to the executing Session — never supplied by the model. The
web half wraps the **existing** `ctx.web` path: `recordFetch` takes a real
`WebFetchResult` that `ctx.web.fetch` produced, so this layer cannot bypass the
fetch provider's SSRF/redirect policy. It records; it does not retrieve.

**The boot probe, through the real profile resolver** (`--profile daily --patch
verify-m7-history.patch.yml`, the daily profile being the one that mounts
`dsh-daily-work` as a bundle):

```json
{ "dailyHistoryServicePresent": true,
  "sessionQueryServicePresent": true,
  "historyAvailable": true,
  "createdSessionId": "session-73311a24-...",
  "selfRead": { "eventCount": 3, "exhausted": true, "watermarkSeq": 2, "generation": 1 },
  "foreignReadRefused": true,
  "foreignRefusalCode": "HISTORY_SESSION_UNAUTHORIZED",
  "pageTraversal": { "pages": 1, "replayCount": 1 },
  "provenanceRecord": { "completeness": "partial", "gapRecovery": ["refetch"],
                        "hashProves": "object identity and integrity only; not truth, and not the correctness of any conclusion" },
  "untrustedContent": { "trust": "untrusted-data", "findingCount": 2,
                        "findingIds": ["imperative-command", "authority-claim"] },
  "error": null }
```

**AND THE PROBE IMMEDIATELY CAUGHT A BUG THAT ALL 80 UNIT TESTS MISSED.**

The first boot returned
`"error": "Error: cannot get property \"sessionQuery\" without inject"`.
`history-plane.ts` used `ctx.sessionQuery`, and property access on a context goes
through the cordis proxy, which throws unless the reading fiber declared the
service in `inject` (`vendor/cordis/src/reflect.ts:136-158`). The plugin must NOT
declare it — the shipped profile configures session-query with `openAt: 'never'`
and a deployment may omit it, so a hard inject would turn a missing optional
service into a boot failure.

The fix is `ctx.get('sessionQuery')`, the documented inject-free read
(`reflect.ts:233-235`). Two tests now pin it: one mounts the plugin through its
**real fiber** and reads (the root context short-circuits the inject check at
`reflect.ts:152`, so a bare `ctx.isolate()` would not reproduce it), and one
asserts a missing service produces a typed refusal naming the DEPLOYMENT rather
than an empty history.

**This is the argument for the boot probe, made by measurement:** 80 unit tests
passed against a module that could not read a single event in a real host.

---

## 3. Where each gate's evidence lives

`tests.txt` is one file, 84 tests. Per-gate test counts:

| gate | tests | the load-bearing one |
|---|---|---|
| HIS-01 | 9 | the refusal happens **before** any observation (asserted via a spy) |
| HIS-02 | 6 | append during an open scan; new events absent; separate scan at a new generation |
| HIS-03 | 7 | segments carry full size + digest and no `event` field at all |
| HIS-04 | 3 | 1 log read / 100 pages, and a byte-level measurement |
| HIS-05 | 4 | the three sets are disjoint and account for every stored event |
| HIS-06 | 2 | both versions present with their own sources and a `supersedes` link |
| HIS-07 | 3 | authority is a function of `author` only, across three author values |
| HIS-08 | 3 | the **real SQLite FTS** index rebuilt after its file was deleted |
| WEB-01 | 3 | `partial` + `refetch`, and the vocabulary has no local-recovery member |
| WEB-02 | 3 | through the real seam, using DSH's own `capSources` truncation flag |
| WEB-03 | 5 | a failed conversion returns **no** body rather than raw HTML |
| WEB-04 | 3 | the old observation is byte-identical after a refetch |
| WEB-05 | 8 | a real loopback server that answers 200 to a `Range` request |
| WEB-06 | 4 | byte offsets verified by re-slicing the artifact |
| WEB-07 | 5 | the notice is asserted equal to DSH's own `trust.ts` string |
| WEB-08 | 7 | a real 64 MiB deflate bomb stopped at the bound |
| ECO-04 | 4 | the prefix is byte-identical across three budget/variable changes |

---

## 4. Design decisions worth stating

**Why the plane never hands out `ctx.sessionQuery`.** The service is trusted host
infrastructure with **no caller authorization** (its README). Handing it out would
make every session in the corpus readable. `HistoryPlane` has no `service`
accessor, no `rawQuery()`, and no method that takes a bare `SessionId` without an
authority attached to the plane that serves it. A structural test asserts the
plane's own property list contains no service-shaped member.

**Why the refusal is checked BEFORE existence for a foreign id.** If "exists in
another project" and "does not exist at all" produced different answers, a caller
could enumerate another project's sessions by guessing. DSH's own
`tool-session-query` makes the same conflation on purpose
(`workspace-access.ts:84-89`: `records.length !== 1` → unauthorized), and it is
the right one for **this** pair. It is not the refusal/absence conflation HIS-01
forbids, which is a different pair and is kept separate (`HISTORY_SESSION_ABSENT`
exists and is tested).

**Why `-1` is a plain number in the watermark.** `SessionSeq` refuses negatives by
construction, and `-1` is how "this log is empty" must be represented without
inventing a second sentinel. The brand is applied at the boundary where a seq is
handed back to session-query.

**Why the segment list is capped at 4.** The offsets ARE payload. A 400 KB event
at 16 bytes/segment would be 25,000 offset pairs — the same budget breach in a
different unit. The digest and total size are what carry the event's identity.

**Why a scan stays open after exhaustion, and is superseded rather than
accumulated.** The pinned observation is also the cheap path for individual event
reads, so closing it on exhaustion would make every later event read pay a full
log read. `openScan` therefore supersedes (and closes) any earlier scan of the
same session, which bounds the map to one pinned observation per session however
often a caller re-opens.

**Why the notice string is duplicated rather than imported.** `dsh-tool-web` does
not export `trust.ts` (its package exports are the root and `./src/*` only), and
importing an unexported source path couples this package to an internal. The test
asserts the two strings are **equal**, so a divergence upstream is a FAIL rather
than a silent drift.

**Where the "hash proves identity, not truth" rule is enforced.** It is a stored
field, not a comment: `ProvenanceRecord.hashProves` and `MemorySource.digestProves`
both carry the sentence, so a consumer reading a hash is told what it proves. A
test asserts the sentence is present on every record type that carries a hash.

---

## 5. FINDING — an upstream observation cache that never hits (honest non-PASS)

**This is a defect I found by measurement, not a gate failure, and I did not fix
it because it is upstream and outside my file ownership.**

`SessionObservationReader` is documented to cache a cold preparation keyed by
`(persistence instance, stat revision)` so that "an unchanged revision reuses the
restored Session without re-reading the log"
(`session-query/src/observation.ts:69-77`). **It never hits.**

The cache check is:

```ts
if (cached === undefined || cached.persistence !== persistence || cached.revision !== revision) return undefined
```

`persistence` comes from `ctx.get('sessionPersistence')` inside
`SessionObservationReader.read` (`observation.ts:106`). That call returns a **new
traceable `Proxy` on every invocation** (`vendor/cordis/src/utils.ts:165-175`
builds it; `reflect.ts:233-235` is the entry), so `cached.persistence !== persistence`
is **always true** and the entry is never reused.

**Measured** (`probe3`, quoted in `tests.txt` as the "reuses the underlying
prepared observation lease" test):

```
revision stable: true
observeSession x6 with cacheSize=32 and stable revision: logReads=6
=> a cache hit would be 1; a value of 6 means the identity half of the key never matches
```

Six observations of one unchanged stored session, with the cache sized 32, cost
**six** full log reads. The revision half of the key matches; the identity half
cannot.

**Consequences, stated precisely:**

- The cache's *bound* (`preparedSessionCacheSize`) and its *eviction logic* are
  still correct and still matter; what is dead is the **hit path**.
- Repeated `sessionQuery.readEvent` / `listEvents` / `readSurface` against a
  persisted session each pay a full log read. For a large log this is the
  "P times full log replay" cost ARCHITECTURE §6 warns about, reached through a
  different door than the one it names.
- **M7 is not exposed to it**, because the plane pins its own observation and
  derives records from that lease rather than calling back into the corpus. That is
  why HIS-04 passes on measurement rather than by luck.

**Not fixed here** because it is an upstream source change in
`packages/session-query/` and `vendor/cordis/`, both outside this milestone's file
ownership. The honest options are to key the cache on the service's stable
identity (e.g. the persistence service's `symbols.original` target) or to resolve
the service once per reader. **Recorded as a finding with a reproduction, not as a
completed fix.**

---

## 6. What is NOT proven (stated plainly)

- **No live network and no paid provider.** No search credential is configured and
  none was used. Every provider is a fixture registered through the real
  `ctx.web` seams; the only real socket is a loopback HTTP server started by the
  WEB-05 test and torn down in `afterEach`.
- **The HTML→markdown converter and the PDF extractor are injected.** The real
  converter is turndown+gfm in `packages/web/tool-web/src/fetch.ts`, which is not a
  package export. WEB-03 therefore proves the **raw/derived separation and the
  failure behaviour**, not turndown's own output. DSH ships no PDF extractor at
  all, so WEB-08 proves the **classification** of extractor outcomes; the real
  streaming decompressor is exercised against a real compression bomb.
- **No claim about any real web page, real PDF, or real search result.** Every
  url, body, session id and hash above is fabricated.
- **HIS-07 is a property of this code, not of the whole system.** `authorityOf`
  and `capabilitiesFor` cannot be talked into granting capability. Whether every
  *other* consumer in a future deployment consults only `authorityOf` is not
  something this milestone can assert.
- **The `daily` profile boot is real, but it is the canary home**
  (`D:\DSH\home\canary5`), not a user's daily home.
- **`tsconfig.check.json` as a whole exits 2**, because this working tree is shared
  with other agents editing concurrently; at capture time the only failing file was
  `src/upg-gates.test.ts`, an untracked file written seconds earlier by another
  agent. M7 owns four files and has **zero** errors in that run; `tsc.txt` RUN 1
  (isolation) and RUN 4 (build) are the M7-attributable results.

---

## 7. Files

**Written by M7:**

- `packages/dsh-daily-work/src/history-plane.ts` — authorization, watermark scans,
  segment budgeting, the replay counter, the three visibilities, versioned memory,
  the rebuildable index, the stable prefix and bounded dynamic tail.
- `packages/dsh-daily-work/src/web-provenance.ts` — WEB-01..08.
- `packages/dsh-daily-work/src/history-plugin.ts` — the real plugin entry
  (`ctx.dailyHistory`).
- `packages/dsh-daily-work/src/history-web.test.ts` — 84 tests.
- `qualification/runners/verify-m7-history.mjs` + `.patch.yml` — the boot probe.
- `qualification/results/M7-history/` — this file, `tests.txt`, `tsc.txt`,
  `source-digests.txt`, `boot-probe.json`.

**Shared files edited additively (other agents edit this tree too):**

- `packages/dsh-daily-work/package.json` — added the `./history` export.
- `packages/dsh-daily-work/cordis.patch.yml` — added "DIFFERENCE 3b" (the
  `daily-history` row).

**Not touched:** `src/host.ts`, `src/record.ts`, `src/counting.ts`,
`src/web-search.ts`, `src/web-search-plugin.ts`, and everything under
`packages/dsh-ipython/`.
