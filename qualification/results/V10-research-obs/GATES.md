# V10 — RESEARCH (RES-01..06) and CACHE/OBSERVABILITY (OBS-01..06)

**Slice:** `qualification/results/V10-research-obs/`
**Deployment identity:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
**Identity re-derivation:** `python qualification/results/T1-spec/verify-identity.py` -> **30/30, exit 0**
(`identity-pre-filing.txt`; the count is 30 rather than 28 because the coordinator added the frozen
as-authored snapshot and the live-ledger checks after this slice began.)

**Build measured against:** `packages/dsh-daily-work/lib`, rebuilt from `src` by every driver in this
slice before it measured. Build digest (all 32 emitted `.js`, name + bytes):
`a9a8369abe7aed00…` — recorded in full in `RES-01-boot-chain.json` -> `buildDigests` and
`OBS-plane-boot.json` -> `buildDigests`. `dsh-ipython` build digest `04057fcad447751f…` in the same
files. No `src` file was newer than its `lib` counterpart at capture time.

Every claim below is labelled `[measured]` or `[read in source]`.

---

## 1. Commands, verbatim

| # | command | output file | result |
|---|---|---|---|
| 1 | `node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/research-chain.test.ts --maxWorkers=1 --no-file-parallelism --reporter=verbose` (cwd `packages/dsh-daily-work`, `NO_COLOR=1`) | `RES-01-research-chain.txt` | exit 0 — **35 passed / 35** |
| 2 | same runner, `src/research.test.ts` | `RES-02-03-research.txt` | exit 0 — **53 passed / 53** |
| 3 | same runner, `src/history-web.test.ts` | `OBS-history-web.txt` | exit 0 — **85 passed / 85** |
| 4 | `node qualification/results/V10-research-obs/probe-obs01-cache.mjs` | `OBS-01-cache-reads.txt` | exit 0 — **6 reads for 6 observations** |
| 5 | `node qualification/results/V10-research-obs/probe-obs06-index.mjs` | `OBS-06-index-rebuild.txt` | exit 0 — index dir deleted, same answer rebuilt |
| 6 | `node qualification/results/V10-research-obs/probe-res02-03-vocabulary.mjs` | `RES-02-03-vocabulary.txt` | exit 0 — vocabulary and parse limits |
| 7 | `node qualification/results/V10-research-obs/probe-reachability.mjs` | `reachability.txt` | exit 0 — 147 files scanned |
| 8 | `node qualification/runners/v10-res01-driver.mjs` | `RES-01-t2-boot.txt`, `RES-01-boot-chain.json` | exit 0 — boot port 3013, port released, probe named the booted home |
| 9 | `node qualification/runners/v10-obs-driver.mjs` | `OBS-02-05-t2-boot.txt`, `OBS-plane-boot.json` | exit 0 — boot port 7322, port released, probe named the booted home |
| 10 | bounded read-only inspection of the zloop source (two named files, no walk) | `RES-06-zloop-port.txt` | exit 0 |

One test file per run, `--maxWorkers=1 --no-file-parallelism`, never two vitest processes at once.
No subagents. No outbound request left this machine: the only sockets opened were loopback servers
started by the tests and probes themselves, and every booted host was killed by the harness with the
port re-checked (`portReleased: true` in both boot reports).

---

## 2. Per-case gate table

### RES-01 — the search-to-citation chain uses real sources (layer T2)

**Oracle.** "Every step carries a real source with a version and a timestamp. A missing key or a
failed fetch is reported as a failure, never turned into a fabricated result or an invented
citation."

**Verdict: PASS, with one named limit.**

| assertion | measurement | verdict |
|---|---|---|
| the search step reaches a real endpoint and its rows become sources | `[measured]` boot probe: the ported provider POSTed `{query, maxResults}` to the loopback origin; the server saw `/search`; 3 rows sent, 1 kept, `utm_source` and `#frag` stripped | PASS |
| the fetch step retrieves the ORIGINAL bytes | `[measured]` shipped `HttpFetchProvider` with its documented `resolveAddresses` seam: served digest `13775969e5986418…` == fetched digest; non-ASCII (`第一段落`, `café`) survived; `truncated: false` | PASS |
| the citation step names a span of the captured object | `[measured]` production `locateClaim`: `kind: located`, `startByte 252`, `endByte 285`, and the bytes at those offsets ARE the quote | PASS |
| a version and a timestamp travel with each step | `[measured]` the artifact's sha256 is the version of the fetched object; `acquiredAt` is the timestamp; the provider's `publishedAt` reaches the model-facing search text (LINK 4) | PASS |
| a failed fetch is a failure, not an empty body | `[measured]` `web_fetch` on an unreachable loopback port -> `isError: true`, `WEB_BLOCKED_URL`, no body. Ported provider on an unreachable endpoint -> `SEARCH_PROVIDER_UNAVAILABLE`, **not** an empty source list | PASS |
| the chain is reachable from the T2 composition | `[measured]` a real Session on the profile's own preset carries 27 tools including `web_fetch` and `web_search` | PASS |

**NAMED LIMIT — the retrieval link is proven against a controlled fake.** There is no live search
credential and `runtime_authorization.live_provider_budget_authorized` is `false`, so the search half
runs against a loopback server written to the port's dialect. The origin half is a real socket
through the shipped provider. This is the same substrate split R6 recorded, and it is kept rather
than averaged.

**NAMED LIMIT — no version IDENTITY across the chain.** Nothing establishes that the fetched page is
the same version as the search row that pointed at it: `publishedAt` is provider prose carried
through unvalidated, and no ETag/Last-Modified/content-hash is compared across the
discovery -> retrieval step. Recorded by R6 as G-WEB-03 and re-confirmed here by reading the shipped
`provenanceFromFetch` request shape (it accepts `etag`/`lastModified`, and no production caller
populates them from a search result).

**REACH FINDING — the ported provider is MOUNTED but NOT SELECTED.** `[measured]` the real resolver
composes 174 entries; the `web` row reads `searchProvider: "deepseek-official"` while the ported row
carries `id: "daily-search"`, and `selectionNamesThePortedProvider: false`. So a search driven
through `ctx.web.search()` reaches a different backend. This is G-WEB-01, re-measured under this
identity, and it is why the chain in the boot probe is driven at the provider level rather than
through `ctx.web.search()` — calling the seam would have placed a REAL outbound request to the
DeepSeek API, which no case here authorizes.

---

### RES-02 — the evidence tier is not inflated (layer T1)

**Oracle.** "The record reports `bytes_captured` and does not claim `primary_read` or `understood`.
The tier vocabulary must not even contain the stronger values as reachable states."

**Verdict: PASS, with the location of the vocabulary stated plainly.**

| assertion | measurement | verdict |
|---|---|---|
| storing a PDF's bytes reports `bytes_captured`, never a reading tier | `[measured]` 53/53 in `research.test.ts`: `captureBytes` produces `bytes_captured` with `coverage: 'none'`; a stored PDF is `bytes_captured` and is NOT any reading tier | PASS |
| the tier vocabulary cannot express `primary_read` or `understood` | `[measured]` `EVIDENCE_TIERS` is a closed const tuple with six members; `advanceEvidence` refuses a skipped step, a backwards step, and any destination outside the tuple; there is no overload taking a bare target tier | PASS |
| no SHIPPED member list contains either token | `[measured]` `probe-res02-03-vocabulary.mjs`: the shipped `AcquisitionCompleteness` is `["complete-within-request","partial","unknown"]`; `GapRecovery` is `["page","refetch","none","unknown"]`; neither contains `primary_read` or `understood`; the shipped `EvidenceRef` schema has fields `["kind","id","digest","label"]` and **no tier/read-state field at all** | PASS |
| the PDF path cannot become a read at all | `[measured]` `web_fetch` on `application/pdf` -> `WEB_UNSUPPORTED_CONTENT_TYPE` and the body is not returned (LINK: "a PDF is REFUSED at the content-type boundary, which is why R02 exists") | PASS |

**NAMED LIMIT — the tier ladder is TEST-LOCAL, and this is the honest boundary of the case.**
`[measured]` a flat scan of all 80 `.ts` files under `packages/dsh-daily-work/src` shows
`primary_read`, `understood`, `range_presented_to_model` and `bytes_captured` appearing in **zero
production files** and only in `research.test.ts`, `research-chain.test.ts` and `cost.test.ts`. The
six-rung ladder the oracle is about is declared in the test files, because DSH has no evidence-tier
concept to import and the project chose to model it against the plan's own words rather than invent
a DSH API for it. What is established for the PRODUCT is the narrower measured fact above: no shipped
member list contains the stronger values, and the shipped evidence reference carries no tier field
through which one could be asserted. `[read in source]`

---

### RES-03 — an incomplete parse reports its own limits (layer T1)

**Oracle.** "The read range and its limitations are stated for each case, and missing content is
never filled in. Using a search snippet as if it were the full text is NOT PASS."

**Verdict: PASS.**

| stimulus | measurement | verdict |
|---|---|---|
| a PDF whose body omits tables | `[measured]` a text-layer extraction is recorded by its range with `complete: false` and `limit: 'text-layer extraction only; table content is not in the text layer'`; the record keeps `states.has('parsed') === false` | PASS |
| ...and a claim about the missing table is refused | `[measured]` `contentAbsenceClaim(record, 'the confidence interval in Table 3')` **throws** `/no complete read exists/` — it does not return an empty string | PASS |
| an empty extraction is not "no content" | `[measured]` shipped `extractPdfText` -> `kind: 'empty'`, `coverage: 'unknown'`, `doesNotMean: 'the document contains no content'` | PASS |
| a 404 | `[measured]` recorded as `responded` with `usable: false`; a parse of it is refused with `HTTP 404, whose body is the server's error document, not the source` | PASS |
| a redirect | `[measured]` a refused redirect is a FETCH failure (`WEB_REDIRECT_BLOCKED`) whose text says the content state is UNKNOWN; an allowed redirect records `finalUrl` so the range is attributable to the page actually read | PASS |
| a truncated body | `[measured]` recorded as truncated AND as an incomplete read; a negative finding is refused from it | PASS |
| a snippet used as full text | `[measured]` `locateClaim(quote, artifact, {origin:'search_snippet'})` -> `not-located`, code `snippet-is-not-full-text`, with the quoted words demonstrably present in the artifact, so the refusal cannot be explained by a failed string match | PASS |
| a quote that is not in the artifact | `[measured]` -> `not-located`, code `text-not-in-artifact`; the match is exact and byte-based, never approximate | PASS |

---

### RES-04 — provider truncation is not local full recoverability (layer T1)

**Oracle.** "`acquisition.completeness` is `partial` with recovery `none` or `refetch`, and the
record does not claim the full text is locally recoverable. Claiming completeness from a truncated
fetch is NOT PASS."

**Verdict: PASS.**

`[measured]` through the SHIPPED `HttpFetchProvider` with a character cap, so `truncated` is produced
by the real transport rather than stated by the probe:

```
servedBodyChars                          280
deliveredChars                            40
deliveredIsAPrefixOfTheServedBytes      true
truncatedFlag                           true
completeness                            "partial"
gaps[0].stage                           "provider-acquisition"
gaps[0].recovery                        "refetch"
recoveryVocabulary        ["page","refetch","none","unknown"]
recoveryVocabularyHasNoLocalArm         true
coverage.claimScope                     "request"
claimsLocalFullRecoverability          false
```

`[read in source]` `GapRecovery` is `'page' | 'refetch' | 'none' | 'unknown'` with an explicit
comment that `refetch` "is deliberately not a local recovery", and there is no `recover-locally`
member. The vocabulary cannot express the claim the oracle forbids.

**Second arm, `[measured]`:** the same cap that TRUNCATES an undeclared body REFUSES a body with a
declared `content-length` over the byte cap (`WEB_FETCH_TOO_LARGE`, no value at all). The pair is
pinned in both directions in `RES-01-research-chain.txt` (LINK 3b / LINK 3c).

---

### RES-05 — raw and derived content are separately identified (layer T1)

**Oracle.** "Raw and derived artifacts carry separate hashes and separate locators, and a failed
conversion produces an explicit failure rather than manufactured body text."

**Verdict: PASS.**

`[measured]` on a real HTML page fetched through the shipped provider:

| assertion | measurement |
|---|---|
| separate hashes | raw `13775969e5986418…` (303 bytes) vs derived `ba8796f2fef58181…` (238 bytes); `hashesAreSeparate: true` |
| separate locators | the record carries `captured.artifact` and `derived.parent`, and `derivedNamesItsParent: true` — the derivation names the raw artifact it came from |
| transform identity recorded | `{name: 'v10-probe-reducer', version: '1.0.0'}` |
| a THROWING conversion | `derived` is `undefined`; gap `stage: 'transform'`, `recovery: 'none'`; the reason names the converter `v10-probe-reducer@1.0.0` |
| an EMPTY conversion | `derived` is `undefined`; gap `stage: 'transform'`; the raw HTML was **not** substituted (`rawHtmlWasNotSubstituted: true`) |
| the assembled record on a failed conversion | `hasDerivedSlot: false`, `gapStages: ["transform"]`, `rawStillPresent: true` |

`[read in source]` the code has no `derived = convert(raw); if (derived === '') derived = raw`
fallback: an empty conversion returns a gap and `undefined`, which is the fabrication the oracle
names.

**NAMED LIMIT.** The converter is INJECTED — the real turndown+gfm converter is not a package export
of `dsh-tool-web`. So this establishes the raw/derived SEPARATION and the failure behaviour, not
turndown's own output on real malformed markup.

---

### RES-06 — a claim is locatable and external content stays untrusted (layer T1)

**Oracle.** "The claim can be located in the captured artifact at a named span, a snippet is not
treated as the full text, and the external content is wrapped as untrusted data that cannot change
host authority or cause execution."

**Verdict: PASS.**

The stimulus is the case's own: ONE page carrying an embedded command, a skill-update instruction and
an authority claim, plus a sentence the claim is built from.

| assertion | measurement |
|---|---|
| the claim is locatable at a named span | `[measured]` `kind: located`, `startByte 252`, `endByte 285`, `sha256` = the artifact digest, and the bytes at those offsets ARE the quote |
| a snippet is not the full text | `[measured]` the same quote with `origin: 'search_snippet'` -> `not-located`, `snippet-is-not-full-text` |
| the external content is wrapped as untrusted | `[measured]` `trust: 'untrusted-data'`; the shipped notice verbatim; `textIsVerbatim: true` |
| the three injection attempts are DETECTED and reported, not obeyed | `[measured]` `findingIds: ["imperative-command","skill-update","authority-claim"]`, `findingCount: 3` |
| it cannot change host authority or cause execution | `[measured]` `capabilitiesFor(content)` returns `[]`; `[read in source]` `UntrustedContent` has no authority/capability/instruction field, so a record of this type cannot express a grant |

---

### OBS-01 — observation caching is measured, not assumed (layer T1)

**Oracle.** "The read count is recorded verbatim. A cache that produces N reads where a hit would
produce 1 is reported as a DEFECT with its cause, not described as a cache that works. A bound and an
eviction policy are not a hit rate."

**Verdict: PASS — the defect is measured and reported, which is what this oracle asks for.**

`[measured]` `probe-obs01-cache.mjs`, verbatim:

```
N (observations of one unchanged session) = 6
preparedSessionCacheSize                  = 32  (ABOVE N, so eviction is not the reason)
revision before observations: 1900922907:161285161655714906:5734:1789861896207557100:1789861896209884000
revision after  observations: 1900922907:161285161655714906:5734:1789861896207557100:1789861896209884000
revision stable across calls: true
ctx.get('sessionPersistence') === ctx.get('sessionPersistence') : false
  both are Proxies over ONE stable target (the escape the fix would use): true
observations issued:            6
lease.source for every read:    ["prepared","prepared","prepared","prepared","prepared","prepared"]
FULL LOG READS OBSERVED:        6
a cache HIT would have produced: 1
```

**This is G-SEAM-23, confirmed at this identity.** The revision half of the key MATCHES; the identity
half cannot, because `ctx.get(name)` returns a fresh traceable Proxy on every call. `[read in source]`
key at `packages/session-query/session-query/src/observation.ts:209`
(`cached.persistence !== persistence || cached.revision !== revision`), proxy built by
`createTraceable` at `vendor/cordis/src/utils.ts:165-175`, entry `ctx.get -> getTraceable` at
`vendor/cordis/src/reflect.ts`, escape `proxy[symbols.original]` at `vendor/cordis/src/utils.ts:181`.
The probe measures the stable target identity directly rather than asserting it.

**Consumer exposure, `[measured]`:** this project is NOT exposed — the history plane pins its own
observation, so a 100-page traversal costs ONE log read (see OBS-04). Any other consumer relying on
this cache pays a full-log load per call. **Not patched upstream.**

---

### OBS-02 — a scan watermark is stable while events append (layer T1)

**Oracle.** "The page order is fixed to one snapshot for the whole scan, and events appended after
the snapshot are read in a separate pass with their own watermark. Interleaving new events into the
running scan is NOT PASS."

**Verdict: PASS.** Measured inside the booted composed host, through the loaded `ctx.dailyHistory`
service (`OBS-plane-boot.json` -> `obs02WatermarkPinned`):

| assertion | measurement |
|---|---|
| the scan is pinned at one watermark | pinned at `{maxSeq: 2, generation: 1}`; first page `[0]` |
| events appended afterwards are ABSENT from the running scan | five events at seq 3..7 appended through the real persistence handle; the continuation returned `[1,2]` and `exhausted: true`; `pinnedScanExcludedAppended: true` |
| the watermark does not move mid-scan | `continuedWatermark == watermarkAtPin` exactly (both `maxSeq` and `generation`); `watermarkUnchangedAcrossPages: true` |
| the new events come from a SEPARATE pass with their OWN watermark | a fresh scan reads `{maxSeq: 7, generation: 2}`, `reopenedSeesAppended: true`, `generationAdvanced: true` |
| a superseded cursor is refused, not re-based | `[measured]` `HISTORY_WATERMARK_SUPERSEDED` in `OBS-history-web.txt` (HIS-02 block), including after `closeScan` and after `dispose` |

---

### OBS-03 — one oversized event does not break the page budget (layer T1)

**Oracle.** "An authorized reference or a segmented read is returned, and the page budget is not
exceeded. Truncating silently, or emitting the whole event inline, is NOT PASS."

**Verdict: PASS.** Measured in the booted host (`OBS-plane-boot.json` -> `obs03OversizedEvent`) on a
200,000-character event read with `maxBytes: 4096`:

```
kind                                  "segments"
totalBytes                            200203
segmentCount                          4
segments                              [{0,4096},{4096,8192},{8192,12288},{12288,16384}]
digestIsHex64                         true
complete                              false
recovery                              "authorized-refetch"
segmentsArmCarriesNoEventBody         true
segmentListIsBounded                  true
eachSegmentIsWithinTheRequestedBudget true
fullArmDigestEqualsSegmentsDigest     true
fullArmBytesEqualsSegmentsTotalBytes  true
```

The event's FULL size and a digest of the FULL event travel with the reference, `complete: false` says
the view is bounded, and there is **no field carrying the event body** in this arm. `[measured]` a
second read at a larger budget returns the value, and its digest MATCHES the segments arm's — the two
arms describe the same object. `[read in source]` the segment LIST is capped at 4 entries, so a tiny
budget against a huge event cannot return thousands of offsets, which would be the same breach
counted in a different unit.

---

### OBS-04 — repeated traversal does not re-replay the whole log (layer T1)

**Oracle.** "A prepared observation or index is reused, and the actual number of full log replays is
recorded as a number. A measured 100 replays for 100 pages is reported as the defect it is."

**Verdict: PASS.**

**The 100-page measurement, `[measured]`** — `OBS-history-web.txt`, HIS-04 block, on a 500-event log
read through a wrapped persistence handle that counts every `open(id,'read')`:

```
pages == 100
seen  == [0..499]
logReads - beforeTraversal == 1
plane.replayCounter().total == 1
```

and the BYTES arm, so a cache that still copies the whole log per page cannot pass on a call count
alone: 500 events of ~1 KB, `logReads == 1`, `oneLog > 400_000` bytes, `bytesRead < oneLog * 1.5`,
`bytesRead < 1_000_000` — where a per-page replay would be ~50 MB.

**The T2 confirmation, `[measured]`** — `OBS-plane-boot.json` -> `obs04Replay`, in the composed host:
a 9-page traversal (the stored session has 9 events, so 9 pages is the whole traversal and
`exhausted: true`) cost `fullLogMaterializationsForTheTraversal: 1`.

**THE CONTROL ARM, and it is the part that makes the `1` mean anything:** a SECOND pinned scan of the
same session must be a second materialization. Measured: `controlArmSecondScanCost: 1`,
`controlHasTeeth: true`. So `1` is a measurement, not a constant. The T1 file pins the same control
(`plane.replayCounter().total` becomes 2 after a second `openScan`).

---

### OBS-05 — the three visibilities stay separate (layer T1)

**Oracle.** "`obtainable`, `consumed` and `model-projected` are recorded as three separate states and
are never merged into one. Reporting a stored event as model-visible, or a consumed event as
projected, is NOT PASS."

**Verdict: PASS.**

`[measured]` in the booted host (`OBS-plane-boot.json` -> `obs05Visibilities`), on the loaded plane's
own records: 9 stored events; seq 0 recorded as consumed and then as projected; the report yields
`storedOnly [1..8]`, `consumedNotProjected []`, `projected [0]`; `threeSetsAreDisjoint: true`;
`unionAccountsForEveryStoredEvent: true`.

The REFUSAL direction is measured on the loaded ledger: recording a projection for a seq that was
never consumed throws `HISTORY_EVENT_ABSENT`, so "the model saw it" cannot be inferred from "it
exists".

`[measured]` in the T1 file (HIS-05 block) the classification uses DSH's OWN three-valued surface
vocabulary, not a second mechanism: a real compaction-style `surfaceOp: {op:'replace'}` produces
`[0,'shadowed'],[1,'shadowed'],[2,'current'],[3,'current']`, and the surface filter pages by
`'shadowed'` / `'current'` through session-query's own types.

**REACH FINDING, recorded here because it is this case's neighbourhood and it is NOT a false PASS.**
`[measured]` `reachability.txt`: the PRODUCT (`packages/**`, non-test) has **ZERO** callers of
`ctx.dailyHistory.history(caller)`. The only non-test caller is this slice's own qualification runner.
The service is mounted and serves authorized reads in the composed host, but nothing in the product
calls it: no model-facing tool (the 27-tool surface contains no history/memory/recall tool), no
Python-cell binding (`ctx.ipython` exposes no `history` method), and the IPython broker protocol
carries no message type that could carry one — `[measured]` `BrokerOpName` is
`["start","execute","interrupt","restart","shutdown","status","kernel_info"]` and `BrokerEvent` is
`["kernel_exited","late_output","diagnostic"]`, with no host-callback or tool-call member. This is a
gap in REACH, not a defect in the three visibilities.

---

### OBS-06 — a derived index is rebuildable from canonical data (layer T1)

**Oracle.** "The index is rebuilt from the canonical Session and artifact data with no second history
source required, and the rebuilt index answers the same queries as before. The rebuild is recorded
with what it read."

**Verdict: PASS.** `[measured]` `probe-obs06-index.mjs`, against the real SQLite FTS5 backend over the
real JSONL persistence:

```
baseline query result: {"itemCount":1,"sessionIds":["v10-obs06-session"],"live":[false],
                        "persisted":[true],"bestMatchSeq":[0],"snippetContainsMarker":true}
index dir before deletion: ["search.db","search.db-shm","search.db-wal"]
index dir after deletion:  [] (exists=false)
canonical session root survived: true -> ["--C-v10-obs06-project--"]
canonical files the rebuild has to work from: [{"entry":"--C-v10-obs06-project--","kind":"dir",
                                                "contents":["v10-obs06-session"]}]
rebuilt query result: {"itemCount":1,"sessionIds":["v10-obs06-session"],"live":[false],
                       "persisted":[true],"bestMatchSeq":[0],"snippetContainsMarker":true}
index dir after the rebuild: ["search.db","search.db-shm","search.db-wal"]
SAME ANSWER AS BEFORE: true
```

The index FILE AND ITS DIRECTORY were deleted (all three files, including `-wal` and `-shm`), a fresh
engine was booted over the surviving session root, and the identical query returned the identical
session id, seq and matching excerpt. **WHAT IT READ** is enumerated rather than asserted: the
canonical session root, whose only contents are the one session's JSONL log — the index directory did
not exist when the rebuild started, so no second history source was available to it.

`[measured]` the same property against the in-memory stand-in in `OBS-history-web.txt` (HIS-08 block),
where dropping and rebuilding from the same canonical events yields an identical row count.

---

## 3. Label-vs-spec mapping (pre-spec labels collide with spec ids)

The test files in this area were authored BEFORE the trusted-local spec existed, so a matching label
is a coincidence to verify rather than a mapping to assume. Every case above was mapped by reading the
spec's `oracle` and finding the measurement that establishes THAT. The collisions worth flagging:

| pre-spec label | where it lives | what it actually measures | the spec case it does NOT map to |
|---|---|---|---|
| `R01` | `research-chain.test.ts` describe block | the four-link search chain | **RES-01 only.** The old spec's R01 and this spec's RES-01 happen to agree; the mapping was checked against the oracle text, not the label. |
| `R02` | `research-chain.test.ts` | evidence tiering / no automatic `understood` | **RES-02** |
| `R03` | `research.test.ts` | incomplete reads state their range | **RES-03** |
| `R05` | `research-chain.test.ts` | observation-then-sampling ordering | **NO spec case.** Not RES-05, which is raw/derived separation. |
| `R07` | `research-chain.test.ts` | prompt stability on the wire | **NO spec case.** |
| `WEB-01` | `history-web.test.ts` | provider truncation -> `partial` | **RES-04** (the spec's RES-04). The `WEB-0n` labels are the OLD M7 web gates, not spec case ids. |
| `WEB-03` | `history-web.test.ts` | raw/derived separation | **RES-05** |
| `WEB-06` | `history-web.test.ts` | claim location | **RES-06** |
| `WEB-07` | `history-web.test.ts` | untrusted content | **RES-06** (second half) |
| `WEB-08` | `history-web.test.ts` | PDF parse failures | **RES-03** |
| `HIS-02` | `history-web.test.ts` | stable watermark | **OBS-02** |
| `HIS-03` | `history-web.test.ts` | oversized event | **OBS-03** |
| `HIS-04` | `history-web.test.ts` | no repeated replay | **OBS-04** |
| `HIS-05` | `history-web.test.ts` | three visibilities | **OBS-05** |
| `HIS-08` | `history-web.test.ts` | index rebuild | **OBS-06** |

The one place this mattered: `WEB-01` in `history-web.test.ts` is NOT the spec's RES-01, and the spec's
RES-04 is NOT `R04` in `research.test.ts` (which is about a request manifest). Both were resolved by
reading the oracle.

---

## 4. Cross-cutting findings recorded by this slice

1. **G-SEAM-23 CONFIRMED at this identity** — the observation cache never hits; 6 reads for 6
   observations at `cacheSize: 32`. Cause measured, not inferred. This project is not exposed.
2. **G-WEB-01 CONFIRMED at this identity** — the ported web-search provider is mounted but NOT
   selected (`web.searchProvider: "deepseek-official"` vs the ported `id: "daily-search"`).
3. **`ctx.dailyHistory.history(caller)` has ZERO product consumers** — a gap in REACH, not a false
   PASS. Mounted and authorized; nothing in the product calls it.
4. **The evidence tier ladder is test-local** — RES-02's vocabulary claim is established against the
   model the tests declare plus the shipped negative; it is not a shipped module.
5. **G-TODO-09, re-verified in this slice** — the zloop port is DONE and the ported discipline holds
   in the shipped code. `[measured]` `RES-06-zloop-port.txt` locates each discipline claim in BOTH the
   zloop source (`E:\zcode-labs\zloop\plugin\runtime\src\zloop\websearch.py`, sha256
   `c2dd81984428f125…`, 1367 lines) and the shipped DSH port: failed provider -> `UNAVAILABLE` /
   `SEARCH_PROVIDER_UNAVAILABLE` with a separate `SEARCH_PROVIDER_ERROR` for an HTTP error; zero hits
   from a WORKING provider is an empty source list; `available()` is presence-only and makes no
   network call; canonicalization strips the fragment and tracking params and refuses embedded
   credentials and non-http(s) schemes without lowercasing or folding trailing slashes; rows with no
   usable URL are dropped. The dual-lane fan-out and browser-session transport are NOT ported, and
   the remainder is a credential-layout blocker rather than code. **Nothing was re-done here** —
   this is a read-only re-verification, and it is filed as a support file rather than as a RES case.

---

## 5. What this slice did NOT prove

- **No live provider, no outbound request.** The search link is proven against a loopback server
  written to the port's dialect; the origin link is a real socket through the shipped provider. No
  credential value was read, printed or logged.
- **No version identity across the chain** (RES-01's named limit; G-WEB-03).
- **The HTML->markdown converter is injected** (RES-05's named limit) — turndown's own output on real
  malformed markup is not claimed.
- **RES-02's tier ladder is test-local**, and the production half of the claim is the narrower one
  measured above.
- **The 100-page traversal is a T1 measurement** (the T2 confirmation ran at 9 pages, because that is
  the whole stored session in a freshly booted host).
- **No case here establishes confinement of any kind**, per the trust model: the OS user account is
  the authority boundary and nothing in this slice claims otherwise.
