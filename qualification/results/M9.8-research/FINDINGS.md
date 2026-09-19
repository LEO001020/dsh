=== M9.8: research evidence gates R03, R04, R08 ===

ARTIFACT: packages/dsh-daily-work/src/research.test.ts
  52 tests, all passing. tsc --noEmit exit 0 under the package's own strict flags.
  Nothing under DSH_HOME, ~/.dsh, or any real user path is read: every id, URL,
  body and marker is fabricated, and no fixture in this file opens a file at all.

GATE STATUS: R03 PASS (one named limit), R04 PASS, R08 PASS (one named limit).
Each limit is stated in full below rather than folded into the verdict.

-------------------------------------------------------------------------------
R03 — INCOMPLETE PARSING
-------------------------------------------------------------------------------

WHAT THE RECORD DISTINGUISHES. The six plan states are a closed const tuple, so
`understood` cannot appear by accident, and no state advances on its own:

  discovered / bytes_captured / parsed / range_presented_to_model /
  cited_in_output / manual_or_automatic_support_checked

The states answer "is this true yet". The RANGE and the LIMITS live in structured
fields beside them, because a state name cannot carry them:

  fetch:     not_fetched | failed{code,detail} | responded{finalUrl,statusCode,
             bytes,truncated,usable}
  parse:     {range:{start,end}, complete, limit?}
  presented: TextRange
  citation:  {url, quoted}

The five required assertions, and what each one actually rules out:

1. BYTES ARE NOT A READ. `recordFetch()` sets `bytes_captured` and never
   `parsed`, even when the body decoded cleanly. The tempting shortcut — "the
   body is a string, so we read it" — is a fact about the transport, not about
   the read, and the test asserts the two states stay apart.

2. A PARTIAL PARSE RECORDS ITS RANGE AND IS NOT FULLY PARSED. `recordParse()`
   adds `parsed` ONLY for `complete: true`. A partial parse keeps
   `{range, complete:false, limit}` and the state stays absent. So
   `states.has('parsed')` means "fully parsed" and `parse.range` answers the
   different question "which part was read". Both are readable; neither stands in
   for the other.

3. A FAILED FETCH IS A FAILURE OF THE FETCH. The `FetchOutcome` union separates
   `failed` from `responded` deliberately. Measured through the REAL `ctx.web`
   seam with a fixture transport, so the `WebFetchResult` values and `WebError`
   codes are DSH's own:
     - HTTP 404 -> `responded`, `usable:false`, because a non-2xx body is the
       server's error document, not the source. `recordParse` then refuses it.
     - `WEB_FETCH_TOO_LARGE` -> `failed`, and NO `bytes_captured`.
     - `WEB_REDIRECT_BLOCKED` -> `failed`; `describeEvidence` says "The FETCH
       failed ... not a finding about the source; the content state is UNKNOWN".
     - `WEB_PROVIDER_CONFIGURED_MISSING` -> `failed`, never an empty source.
   `contentAbsenceClaim()` — the only function that may say "the source does not
   contain X" — THROWS unless a complete parse exists. It does not return an
   empty string, because an empty string is indistinguishable from a real
   negative answer. That is the failed-versus-empty rule, applied structurally.

4. A SNIPPET IS NOT FULL TEXT AND CANNOT BE PROMOTED. `origin` is a
   discriminated field, and `recordParse` refuses any record whose origin is
   `search_snippet` with `EVIDENCE_SNIPPET_IS_NOT_TEXT`. A snippet may be cited
   (that is a normal thing to do) and citing it adds only `cited_in_output` —
   never `parsed`. Proven through the real seam with the ported provider from
   `src/web-search.ts`, so the snippet is a genuine `WebSearchSource`.
   The search-side half of the same rule is asserted too: a provider that
   answers HTTP 503 produces `SEARCH_PROVIDER_ERROR`, not an empty source list.

5. NO AUTOMATIC `understood`. Asserted four ways: the tuple is exactly those six
   names; no name matches /understand|comprehend|known|learned|absorbed/; no
   record at any stage has an `understood` field or serializes the word; and
   `manual_or_automatic_support_checked` is reachable ONLY by an explicit
   `recordSupportCheck()` call — parsing, presenting and citing all leave it
   absent. Reading is not verifying.

THE PDF ARM, AND ITS LIMIT. This is the one thing R03's stimulus names that is
NOT fully reachable, and it is a real DSH fact rather than a gap in the test:

  - `web_fetch` accepts only the two body kinds in `WebFetchBody`
    (packages/web/web/src/types.ts:93-95), and `classifyContentType` returns
    undefined for anything outside text/html, text/*, application/json and
    application/xml (packages/web/web-fetch-http/src/policy.ts:78-84). A PDF URL
    therefore throws WEB_UNSUPPORTED_CONTENT_TYPE before any body is read
    (packages/web/web-fetch-http/src/provider.ts:149-153).
  - So a PDF fetched through this seam never reaches even `bytes_captured`. The
    test asserts that, and asserts the record reports an UNKNOWN content state
    rather than an absence of tables.
  - "PDF text missing tables" is exercised at the RECORD level: a text-layer
    extraction that omits tables is recorded as `complete:false` with the limit
    "text-layer extraction only; table content is not in the text layer", and a
    claim about the missing table is refused.

  WHAT IS NOT PROVEN: no document pipeline exists, so no PDF is ever decoded and
  no real extractor is exercised. The record type and the refusal are qualified;
  the retrieval route for PDFs is not. R03's oracle also says "必要时换真实解析/
  视觉途径" — switching to a real parsing or visual route when needed. That route
  does not exist yet, and this file does not claim it does. If a reader requires
  an end-to-end PDF read for R03, this evidence does not supply it and the gate
  should be treated as partial.

-------------------------------------------------------------------------------
R04 — COMPACTION VISIBILITY
-------------------------------------------------------------------------------

THE MEASURED COUNTEREXAMPLE, on a REAL Session (not a mock):

  seq 0  user/message  OBSERVATION: the fixture report claims a 12% gain.  (surfaceOp: append)
  seq 1  user/message  OBSERVATION: an unrelated second note.             (surfaceOp: append)
  seq 2  user/message  SUMMARY: two earlier observations were compacted.  (surfaceOp: replace 0..0)

The replacement is byte-for-byte what `compactSurfaceRegion` appends
(packages/compaction/compaction-basic/src/region.ts:507-510):

  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })

The `compaction/start|summary|end` records are deliberately NOT appended: they
are log-only events with no surfaceOp (packages/compaction/compaction/src/types.ts:26),
and `surfaceOpOf` throws for any non-surface-eligible event carrying one
(packages/core/session/src/surface.ts:283-288). So omitting them cannot change
the surface this gate measures.

WHAT IS ASSERTED:

  - `buildRequestManifest()` reads `session.surface.nodes` and
    `session.deriveMessages()`, and records the explicit seqs and message ids.
    Its `basis` field is the literal `'explicit-inclusion'`.
  - The manifest does NOT contain seq 0, the compacted-away observation, and
    DOES contain seq 2. The model-visible text no longer contains the 12% claim.
  - THE SHORTCUT IS WRONG, DEMONSTRATED. `inferVisibleByMaxSeq(session, maxSeq)`
    returns every seq 0..maxSeq. It contains seq 0; the real manifest does not.
    The test asserts the two sets differ by EXACTLY `[0]` — nothing the shortcut
    omits, only something it wrongly adds. The error is one-directional and
    always claims MORE was seen than really was, which is the dangerous direction.
  - The visible seqs are NOT ASCENDING: `surface.nodes` is `[2, 1]`. A replacement
    lands at a higher seq while occupying an older surface position, so no rule of
    the form "everything at or below some seq" can express this surface at all.
    That is the structural reason the shortcut is invalid, not merely inaccurate
    on one example.
  - The plan's own case is covered: a two-node `tool/result` range replaced by one
    summary, where the shortcut re-admits both removed results.

WHY THE REAL DERIVATION IS THE ONLY CORRECT SOURCE. `Session.deriveMessages()`
walks `surfaceOp` markers, and its own doc comment states the property
(packages/core/session/src/index.ts:825-829): "every message-producing append
records its `surfaceOp`, so a raw event with no marker (a chunk, a turn boundary)
is correctly absent, and a compaction `replace` deletes the shadowed nodes from
the derivation."

LIMIT, STATED: no real `CompactionEngine` run is involved — that needs `llm` and
`tokenMeter`. The surface transition is the one compaction appends, appended
directly. What is qualified is the VISIBILITY SEMANTICS of a compacted surface
and the invalidity of the max-seq shortcut. What is not exercised is the
compaction engine's own range selection.

-------------------------------------------------------------------------------
R08 — EVIDENCE ACCESS SCOPE
-------------------------------------------------------------------------------

`SessionScope` holds exactly one thing — the allow-list — and consults the store
ONLY AFTER the allow-list has admitted the id. That ordering is the whole design:
`ctx.sessions.get(id)` returns `undefined` for both "not authorized" and "does not
exist", so consulting the store first would collapse a refusal into an apparent
absence. `read()` therefore throws; it never returns `undefined`.

  - INSIDE the allow-list: returns the real `Session` from a real `SessionStore`
    (asserted by identity against `store.get(id)`, not merely by id).
  - OUTSIDE it: throws `SESSION_QUERY_TOOL_UNAUTHORIZED` — DSH's own refusal code
    (packages/session-query/tool-session-query/src/service-boundary.ts:92-97).
    The test asserts the target session REALLY EXISTS first, so the refusal cannot
    be explained as absence, and asserts the code is NOT
    `SESSION_QUERY_SESSION_NOT_FOUND`. A genuine not-found is separately asserted
    to produce the not-found code, so the two stay distinguishable.
  - `list()` reports only authorized ids and does NOT stand in for a refused read.
  - NO IMPLICIT WIDENING, six ways: an empty allow-list is refused at construction
    ("an empty list is not a wildcard"); a `'*'` entry is a literal id and matches
    nothing; the allow-list is COPIED so mutating the caller's array cannot widen a
    live scope; the instance exposes no `store`/`root`/`home`/`path`/`cwd` accessor
    (checked both in the property list and at runtime, which is why the fields are
    `#private` — a TypeScript `private` is erased and would leave `scope.store` a
    real property); no `allowAll`/`fromEnvironment`/`unscoped` static exists; and
    `read()` takes only a session id, so there is no path argument to escape
    through — a path-shaped argument is just an id off the allow-list.

LIMIT, STATED: this is the PROJECT's guard, built and asserted here. It is not yet
wired into a production tool surface, so what is proven is the guard's properties,
not that a deployed daily profile routes every history read through it. Separately,
DSH's own session-query tool authorization is a DIFFERENT model — workspace/cwd
scoped, not allow-list scoped (packages/session-query/tool-session-query/src/
workspace-access.ts:96-99, `headerAuthorized`). The two are complementary, and this
file does not claim DSH's own authorization was replaced or measured. The
`DSH_HOME`-not-mounted half of the oracle is addressed only as "the scope object
has nothing that names a filesystem location"; no mount configuration was audited.

-------------------------------------------------------------------------------
WHAT THESE THREE GATES SHARE
-------------------------------------------------------------------------------

All three are the same defect in different clothes: a state that was never
observed gets reported as a state that was. R03's `failed` is never an absence,
R04's shortcut never claims less than it saw, R08's refusal is never an empty
result. In each case the fix is the same shape — make the unknown state
representable and make the tempting shortcut throw instead of returning something
that reads like an answer.

FILES IN THIS DIRECTORY
  FINDINGS.md          this file
  tests.txt            real vitest output, 52 passed, test_exit=0
  tsc.txt              package tsc exit 0, PLUS the test-file typecheck; see the
                       note in that file — the package tsconfig EXCLUDES
                       src/**/*.test.ts, so the package command alone is a FALSE
                       PASS for a test artifact
  source-digests.txt   sha256 of the test file and of every DSH source cited above
