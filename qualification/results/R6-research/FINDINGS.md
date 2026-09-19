=== R6: repair episode on gate R01, the real search chain, and the web/research plane ===

SUBJECT, read-only, NOT edited by this slice:
  src/web-search.ts         8d6ec8fca407daba46f7cde629d7a3d4ff8d00418746fa9806c14d7ba2226649
  src/web-search-plugin.ts  1ede5df10b05e0afdb5a9840ad046a034389bdfe1a108d68b38af77cc1d05350

ARTIFACTS THIS SLICE OWNS AND CHANGED:
  src/research-chain.test.ts  851097cb20e05c5c2edc8461363424674cd935bbc903d1175a71b149796b7793
      35 tests (was 29), all passing
  src/web-search.test.ts      8b290d4ce2b586f9a21188a98744a6694cfe4af8fa7cf6ae4dfe645a6c193915
      26 tests (was 24), all passing
  src/research.test.ts        8f493df43d8782685ac3f35bf1e77070856a02e4fac248988d9865e9427f12d7
      53 tests (was 52), all passing

  Total for this slice: 114 tests, 0 failures.

  $ tsc -p tsconfig.json --noEmit        -> exit 0
  $ tsc -p tsconfig.check.json           -> exit 0, 0 errors in the whole tree

  Both commands are recorded verbatim in tsc.txt. The check config type-checks
  EVERY test file in the shared workspace, so its exit code is an aggregate that
  moves while other agents work; at capture time it was 0 with zero `error TS`
  lines anywhere, so there was no sibling noise to attribute.

  Evidence files in this directory:
    source-digests.txt        the five files above, hashed
    tests-research-chain.txt  the 35 R01/R02/R05/R07 tests, verbose
    tests-web-search-and-research.txt  the other 79, verbose
    tsc.txt                   both tsc invocations with exit codes
    resolver-reachability.mjs / .txt   the real-resolver probe and its output


-------------------------------------------------------------------------------
WHAT R01's RECORDED STATUS ACTUALLY SAID, AND WHAT THIS SLICE FOUND
-------------------------------------------------------------------------------

gates.json records R01 as NOT_RUN with a PARTIAL note: the four links are proven
against DIFFERENT substrates, and each test says which. That note is accurate,
and the per-test labelling it describes is real -- each R01 test names its own
substrate in its title. This slice did not find a mislabelled substrate.

What it found is that three of the four links had an assertion WEAKER THAN THE
CLAIM THEIR OWN COMMENT MADE, which is the failure mode this project keeps
hitting (G-FIX-04: an oracle weaker than its scenario). Each is listed under
"WHAT WAS STRENGTHENED" with the exact change.

It also found, and this is the substantive new result, that the retrieval link is
blocked by MORE THAN THE BUDGET FLAG. See "WHY A REAL PROVIDER IS NOT AVAILABLE".


-------------------------------------------------------------------------------
PER-LINK VERDICT
-------------------------------------------------------------------------------

  LINK 1, retrieval -- CONTROLLED FAKE, and the fake DOES exercise the real
        parse/rank code. VERDICT: the assertion has teeth (mutation-tested).
        Substrate: a loopback HTTP server answering the port's dialect, through
        the real `ctx.web.registerSearchProvider` seam and the real
        `dsh-tool-web` `web_search` tool.

    The single most important question in this task was whether the fake bypasses
    the ported parse/rank code and returns a hand-built result. IT DOES NOT. The
    test registers the real provider and calls the real tool, so the payload
    travels server -> `createDualLaneSearchProvider.search` -> `mapHits` ->
    `canonicalSourceUrl` -> `ctx.web.search` -> `capSources` -> the tool's
    `mergeSearchResults` -> `formatSearchOutput`.

    That was not taken on trust. Two MUTATIONS were injected into the subject and
    each was caught by the assertion:

      1. Replacing `mapHits(hits, maxResults)` with a hand-built
         `hits.slice(0,maxResults).map(...)` (i.e. exactly the "bypass the parse
         code" failure) -> LINK 1 FAILED, because the tracking parameter survived
         into the cited URL.
      2. Deleting only the dedup lines (`if (seen.has(canonical)) continue`) ->
         LINK 1 FAILED, because two rows cited the same page.

    Both mutations were reverted and the file re-hashed to the digest above.
    Mutation (1) was re-run a THIRD time after the final refactor of LINK 4 (the
    `!`-removal pass) and was still caught, so the oracle did not weaken while the
    tests were edited. `src/web-search.ts` is byte-identical to its original hash
    `8d6ec8fca407daba46f7cde629d7a3d4ff8d00418746fa9806c14d7ba2226649` after every
    probe, which is the check that the mutation was actually undone.
    Note on (2): `dsh-tool-web`'s own `mergeSearchResults` also dedups by URL, so
    the LINK 1 assertion had to distinguish "the provider collapsed it" from "the
    tool collapsed it". It does, because the assertion is on the ROW COUNT of the
    surviving source list and on `truncated: true`, which only the provider sets
    when it drops rows to honour its bound.

    NOT PROVEN: that a real search API answers in this shape. See below.

  LINK 2, original fetch -- REAL LOOPBACK HTTP SERVER through the real `ctx.web`
        seam. VERDICT: was weaker than claimed; STRENGTHENED.
        Substrate: real `HttpFetchProvider`, real socket, real server.

    The claim is "the model sees the ORIGINAL bytes". The assertion was
    `expect(value.body.content).toBe(page)` -- string equality on a pure-ASCII
    body. That proves the characters matched, not the bytes: an ASCII page
    round-trips through any decode that is merely close enough.

    STRENGTHENED: the body is now non-ASCII (`第一段落 — 12% 改善。 café ✓`) and
    the assertion is a SHA-256 DIGEST of the served bytes compared to a digest
    taken over `value.body.content` re-encoded as UTF-8. A wrong charset, a lossy
    transcode, or a cut inside a multi-byte character now changes the digest.
    `truncated: false` is also asserted, so a silently short body cannot pass.

  LINK 3, complete relevant range -- REAL LOOPBACK SERVER. VERDICT: was weaker
        than claimed; STRENGTHENED, and the mechanism was corrected.
        Substrate: real `HttpFetchProvider` with an injected character cap.

    The claim is that the bound is ENFORCED and that the caller can TELL the
    range is incomplete. The old assertion did show enforcement
    (`content === '0123456789'` against a 20-character body, `truncated: true`,
    a "Content truncated" footer, and the dropped tail absent) -- so the link was
    not hollow. But it never observed the server side, so it could not distinguish
    "the client cut the body" from "the server sent a short body".

    STRENGTHENED: the test now asserts `server.requests` shows the request
    arrived, and that the kept prefix is a genuine prefix OF THE SERVED BYTES.
    Two further tests were added because the first draft of this one was WRONG:

      LINK 3b. A body with a DECLARED `content-length` over the byte cap is
      REFUSED with `WEB_FETCH_TOO_LARGE` and returns no value at all -- a refusal,
      not a range. The first draft of this test omitted the explicit
      `content-length`, and it FAILED: Node answers `res.end(string)` with
      `transfer-encoding: chunked`, so no length is declared and the transport
      takes the truncation branch instead. The premise was wrong, the failure was
      investigated rather than tuned away, and the test now states the declared
      length explicitly so the refusal path is genuinely reached.

      LINK 3c. The SAME cap that refuses a declared overrun TRUNCATES an
      undeclared one, returning exactly `maxResponseBytes` bytes flagged
      truncated. The pair pins the distinction in both directions, so neither
      branch can stand in for the other.

    So: the bound is enforced, observed on both sides of the socket, and the two
    ways of exceeding it are distinguished rather than averaged.

  LINK 4, citation -- REAL FETCH, controlled fake for the search. VERDICT: was
        weaker than claimed in two ways; STRENGTHENED in both.
        Substrate: real `HttpFetchProvider`; search rows from the loopback fake.

    Claim (a): the citation names a page this process actually retrieved,
    verified by digest. The old assertion checked `statusCode === 200` and string
    equality on `'the original bytes'` -- a 200 is not a digest, and the body was
    ASCII. STRENGTHENED: the page is non-ASCII, the digest is taken over the
    bytes the SERVER was handed, and the fetched content is asserted to hash to
    it. The model-facing fetch text is also asserted to carry the cited URL.

    Claim (b): the recorded note says "a search snippet substituted for full text
    stays a snippet". The check requested was whether this is ASSERTED or merely
    DESCRIBED. It was asserted -- but only against a TEST-LOCAL model of the
    evidence record, in `research.test.ts`. That proves the discipline, not that
    any shipped code enforces it. STRENGTHENED: the claim is now asserted against
    the PRODUCTION locator, `locateClaim` in `src/web-provenance.ts` (reached in
    production through `dsh-daily-work/history`), in both files:

      - `research-chain.test.ts` LINK 4b runs the whole path through the real
        seam: search -> snippet reaches the model -> fetch the ORIGINAL -> locate
        the quote in the captured artifact.
      - `research.test.ts` asserts the same refusal at the locator.

    Both use the STRONGEST available form: the quoted words ARE present in the
    captured artifact (`artifactText` is asserted to contain the quote), so the
    refusal cannot be explained away as "the text was not found". The only thing
    that changes the verdict is the origin tag. Same string, same artifact:
    `locateClaim(quote, artifact)` -> `located`;
    `locateClaim(quote, artifact, {origin:'search_snippet'})` ->
    `not-located` with code `snippet-is-not-full-text`.

  FAILURE-IS-NEVER-EMPTINESS -- unchanged and already strong. Five failure
  shapes each get their own code, and the complement is asserted too, so the
  distinction is pinned from both sides. This slice added no failure-shape test
  because it could not find a way to make them stronger: each already asserts a
  specific code AND that no request was attempted where that is the claim.


-------------------------------------------------------------------------------
THE FOURTH LINK SET: WHAT "A REAL SOURCE AND A VERSION" MEANS, AND ONE GAP
-------------------------------------------------------------------------------

R01's oracle says "every step carries a real source and a version". The URL is
the source and the fetch's status code plus the provider's `publishedAt` are the
version-ish facts. LINK 4 now verifies the source by digest, which is the
strongest form available.

NOT PROVEN, and stated because the oracle's word is "version": nothing in this
chain establishes that a fetched page is the SAME version as the search result
that pointed at it. `publishedAt` is a provider-supplied string and the port
carries it through unvalidated; there is no ETag, Last-Modified or content-hash
comparison between the search row and the fetched bytes. A page that changed
between discovery and retrieval would be cited as though it had not. The
provenance module has the fields for this (`etag`, `lastModified` on
`provenanceFromFetch`) but no production caller populates them from a search
result, and `searchProvenance` records no version at all. Recorded as a gap
below rather than papered over.


-------------------------------------------------------------------------------
WHY A REAL PROVIDER IS NOT AVAILABLE -- AND IT IS NOT ONLY THE BUDGET FLAG
-------------------------------------------------------------------------------

The recorded reason is `compatibility.lock.json` ->
`runtime_authorization.live_provider_budget_authorized: false`, with
`scope: LOCAL_IMPLEMENTATION_ONLY`. That was verified rather than assumed:

  $ python -c "..." compatibility.lock.json
    .runtime_authorization.scope = LOCAL_IMPLEMENTATION_ONLY
    .runtime_authorization.live_provider_budget_authorized = False

So the budget flag is real and it is sufficient on its own to forbid a live run.
But it is NOT the only obstacle, and this slice measured a second, independent
one that the budget flag was masking:

  THE PORT SPEAKS A DIFFERENT DIALECT FROM THE ENDPOINT THE PRODUCT IS
  CONFIGURED TO CALL.

`packages/dsh-daily-work/cordis.patch.yml` (DIFFERENCE 3) inserts the provider
with `endpoint: https://api.exa.ai/search` and `apiKeyEnv: EXA_API_KEY`. But:

  - The port's request body is `{query, maxResults}`
    (`web-search.ts:195`). Exa's request body is
    `{query, type, contents:{highlights}, numResults}` -- the count field is
    `numResults`, not `maxResults`
    (`packages/web/web-search-exa/src/types.ts`, `ExaSearchRequest`).
  - The port's response rows are read as `url`/`title`/`snippet`/`publishedAt`
    (`web-search.ts:99-104`, `mapHits`). Exa's rows are
    `url`/`title`/`highlights[]`/`publishedDate`
    (`packages/web/web-search-exa/src/types.ts`, `ExaResult`).
  - The port sends NO credential header at all: `headers: {'content-type':
    'application/json'}` only (`web-search.ts:194`). Exa's own provider sends
    `authorization: Bearer <key>`
    (`packages/web/web-search-exa/src/provider.ts:105`). The port reads
    credential PRESENCE through `ctx.credentials.describe` and never the value,
    by design.

MEASURED, not read off the source. `LINK 1b` calls the shipped `mapHits` with an
Exa-shaped row and asserts the consequence: the URL survives (so a live Exa
answer would still yield citeable links -- the failure is degraded, not total)
but `snippet` and `publishedAt` are ABSENT, because the port does not read
`highlights`/`publishedDate`. `web-search.test.ts` pins the same mismatch and
also pins the request contract: exactly two body keys and exactly one header.

THE CONSEQUENCE FOR THE GATE. Authorizing a paid budget would NOT make this
provider work against the configured row. The live half of R01 is therefore
blocked by a CODE gap (a dialect adapter that does not exist) on top of the
authorization gap. That is a stronger and more useful statement than
"BLOCKED_EXTERNAL", and it is why the live half must not be recorded as a PASS
even if a budget were later granted.

Note on DSH's own answer to this: the checkout ships a correct Exa provider
(`@deepseek-ai/dsh-web-search-exa`) and a DeepSeek one
(`@deepseek-ai/dsh-web-search-deepseek`), each in its own package with its own
wire types. The port reimplements the seam against a shape neither of them
speaks. Reconciling the two is a code change, not a qualification run, and it is
outside this slice's file ownership (`web-search.ts` is read-only here).


-------------------------------------------------------------------------------
IS THERE A FREE, CREDENTIAL-LESS ENDPOINT? -- AND WHAT IT WOULD CHANGE
-------------------------------------------------------------------------------

Short answer: yes, several exist, and NONE of them would upgrade R01's substrate.
The controlled fake is the honest maximum. The reasoning is worth stating because
"just point it at a free API" is the obvious-looking move.

Candidate free, credential-less endpoints:
  - Wikipedia's `action=query` search API (no key).
  - DuckDuckGo's HTML endpoint (no key; scraping-shaped and rate-limited).
  - Any public JSON search proxy.

Each speaks a THIRD dialect: not the port's `{query,maxResults}` -> `{results:
[{url,title,snippet,publishedAt}]}`, and not Exa's either. So pointing the
loopback fake at one of them would change what is proven from "the port works
against a server we wrote to its spec" to "the port works against server X after
we added an adapter for X" -- which is a NEW claim about a new adapter, not an
upgrade of the existing one.

More importantly, it would not close the gap that matters. R01's live half asks
whether the PROVIDER CONTRACT the port assumes is a real contract. A free
endpoint answers a different question: whether the port can be made to talk to
something. The test would still be asserting against a server chosen to fit the
code, and the honest label would still be "controlled", so the upgrade would be
cosmetic while looking like a stronger green light. That is precisely the
substitution this project's constraints forbid.

What WOULD change the substrate, in order of strength:
  1. A budget authorization AND an adapter to a real paid provider's dialect,
     with the request shape and credential header asserted on the wire. This is
     the only thing that closes R01's live half.
  2. Replacing the port with the shipped `dsh-web-search-exa` provider and
     testing THAT against the loopback fake. This would prove a provider whose
     dialect is documented to match a real API, which is strictly better than
     proving a bespoke shape. It is a product change and outside this slice.
  3. Nothing else. A free endpoint is not on this list.

No outbound request left this machine in this slice. The only sockets opened were
loopback servers created by the tests themselves. No credential value was read,
printed or logged; the only credential-related fact asserted is that the port
sends NO auth header.


-------------------------------------------------------------------------------
THE LOOPBACK vs SEC-04 TENSION, RESOLVED AND MEASURED
-------------------------------------------------------------------------------

The tension is real and it is not a contradiction. SEC-04 records PASS: the
address policy refuses loopback, link-local, private and transition classes, and
refuses the WHOLE answer set if any member is non-public. R01's origin tests
fetch from `127.0.0.1`. A reader seeing both claims should ask whether R01 is
quietly running with the guard off.

It is not, and the difference is a CONSTRUCTOR PARAMETER, not a bypass:

  `HttpFetchProvider`'s second constructor argument is `resolveAddresses`, typed
  `HttpFetchResolver` and documented at `network.ts:33` as the signature "used to
  test public-address policy without process DNS changes"
  (`packages/web/web-fetch-http/src/provider.ts:46-49`).

  The SHIPPED default is `publicHttpNetwork.resolve` (= `resolvePublicAddresses`).
  R01's origin tests pass a resolver returning `127.0.0.1`; every test that
  asserts a REFUSAL constructs the provider WITHOUT the parameter. No module is
  monkeypatched, and the guard is not disabled -- a provider built with the
  default still refuses the same URL in the same process.

MEASURED, not asserted in prose. `LINK 4c` does exactly this in one process:
the same loopback URL is fetched through (1) a provider with the shipped default
resolver, which refuses it with `WEB_BLOCKED_URL` and -- asserted -- the server
never sees a request, so the refusal happens BEFORE the socket; and (2) a
provider with the documented seam, which succeeds and serves the body. One URL,
two providers, opposite outcomes, no module patched. That is the whole
difference, and it is now an observation rather than a footnote.

This is also why SEC-04's own file records that the guard "is NOT an egress
boundary": a confined child reaches the same class of address with no tool
involved. R01 does not depend on that fact; it uses the supported seam.


-------------------------------------------------------------------------------
PRODUCTION REACHABILITY -- VERIFIED THROUGH THE REAL RESOLVER, WITH A FINDING
-------------------------------------------------------------------------------

Checked through the REAL profile resolver, not by reading the patch, as
instructed. `resolver-reachability.mjs` imports `loadProfile` and
`composeEntries` from the pinned checkout's built `app-boot`, resolves a
throwaway `$DSH_HOME` whose `daily-candidate` profile lists `dsh-daily-work`
among its bundles, and composes the tree.

  RESULT 1, the row IS composed. `daily-web-search` is present in the composed
  entry list with `name: dsh-daily-work/web-search` and its full config, so
  `web-search.ts` / `web-search-plugin.ts` ARE reachable from a non-test file
  through the package's `./web-search` export. The import-graph check
  (`qualification/results/R3-unwired/import-graph.txt`) agrees independently:
  `./web-search -> src/web-search-plugin.ts` is an ENTRY, and
  `src/web-search.ts` is REACH with `non-test importers: src/web-search-plugin.ts`.

  The traps were respected rather than re-learned: the probe goes through
  `loadProfile`/`composeEntries` so the bundle-patch ordering is the real one,
  and `--dump-config` (610 lines) confirms the same row survives to the final
  composed tree.

  RESULT 2, AND THIS IS A FINDING: the row is composed but the provider is NOT
  SELECTED. The composed `web` row reads:

      - id: web
        name: '@deepseek-ai/dsh-web'
        config:
          searchProvider: deepseek-official
          fetchProvider: http

  Our provider's config names it `daily-search`. Nothing in this package's patch
  touches the `web` row (`grep -c searchProvider cordis.patch.yml` = 0), so the
  shipped selection stands and `WebRuntime.search` resolves by
  `deepseek-official` -- a different backend.

  So the honest statement is: the ported provider is MOUNTED and REACHABLE, and a
  search does not reach it. "Wired" is too strong. This is asserted at the seam in
  LINK 1c, which registers BOTH providers, names the shipped id as the selection,
  and asserts that the selected provider receives the call while the loopback
  origin our provider points at receives ZERO requests. That test was itself
  mutation-checked: flipping the selection to `daily-search` makes it fail.

  Two consequences worth stating:
    - The M7.1 PORT-NOTES claim that "dsh-tool-web's existing web_search tool
      routes to it" is true of the REGISTRY and not of the composed profile.
    - Whether this is a defect depends on intent. If the port is meant to be the
      daily deployment's search backend, the `web` row needs an override. If it
      is meant to be available-but-not-default, nothing is broken and the claim
      should be softened to "mounted, not selected". This slice does not edit
      `cordis.patch.yml` beyond what is reported below, because the file is
      SHARED and the decision is not mine.

SHARED-FILE CHANGES: NONE. No addition was made to `cordis.patch.yml` or
`package.json` in this slice. The reachability finding is a REPORT, not a fix:
changing the selection would alter the deployment's search backend, which is a
product decision and not a test-repair. Both files are untouched by me.


-------------------------------------------------------------------------------
WHAT WAS STRENGTHENED (exact list)
-------------------------------------------------------------------------------

  1. LINK 2: ASCII string equality -> SHA-256 digest of non-ASCII served bytes.
     Added `truncated: false`.

  2. LINK 3: added server-side observation (the request arrived; the kept prefix
     is a prefix of the served bytes).

  3. LINK 3b (NEW): a declared `content-length` over the byte cap is a REFUSAL
     (`WEB_FETCH_TOO_LARGE`, no value), not a truncated range. The first draft was
     WRONG -- Node used chunked encoding, no length was declared, and the test
     failed; the premise was corrected rather than the assertion loosened.

  4. LINK 3c (NEW): the same cap TRUNCATES an undeclared body. The pair pins both
     branches.

  5. LINK 4: digest-verified original (non-ASCII), plus the model-facing fetch
     text carrying the cited URL.

  6. LINK 4b (NEW): "a snippet substituted for full text stays a snippet" is now
     asserted against the PRODUCTION `locateClaim`, with the quoted words present
     in the artifact so the refusal cannot be explained by a failed string match.

  7. LINK 4c (NEW): the loopback-vs-SEC-04 reconciliation, measured: the shipped
     resolver refuses, the documented seam reaches, one process, no patching.

  8. LINK 1: the wire shape is asserted (POST body keys, `content-type`) and the
     ABSENCE of any credential header is asserted as a property of the request
     that left the process.

  9. LINK 1b (NEW): the dialect mismatch, measured through the shipped `mapHits`
     against an Exa-shaped row.

  10. LINK 1c (NEW): mounted-but-not-selected, measured at the seam with both
      providers registered.

  11. `web-search.test.ts`: the request contract is pinned (exactly
      `{query, maxResults}`, exactly one header) and the Exa dialect mismatch is
      pinned against the shipped mapper.

  12. `research.test.ts`: the snippet claim is additionally asserted against the
      production `locateClaim`.

  No test was deleted, skipped, or loosened. No N was lowered. The one test that
  failed during development (LINK 3b) failed because its PREMISE was wrong, and
  the fix was to state the server's `content-length` explicitly so the refusal
  path is genuinely reached -- the assertion itself was not relaxed.


-------------------------------------------------------------------------------
WHAT IS NOT PROVEN (explicit)
-------------------------------------------------------------------------------

  1. THAT A REAL SEARCH API ANSWERS IN THE PORT'S SHAPE. The retrieval link is
     proven against a server written to the port's dialect. No live provider was
     contacted, no key was read, and no outbound request left this machine.

  2. THAT THE PORT WOULD WORK AGAINST THE ENDPOINT IT IS CONFIGURED WITH. It
     would not, as written: the configured row is Exa and the port speaks a
     different dialect with no credential header. Measured in LINK 1b. A budget
     authorization alone would not close this.

  3. THAT A SEARCH REACHES THIS PROVIDER IN THE COMPOSED PROFILE. It does not:
     the `web` row selects `deepseek-official`. The row is composed and reachable;
     the provider is not selected. Measured in LINK 1c and by the real resolver.

  4. VERSION IDENTITY ACROSS THE CHAIN. Nothing establishes that the fetched page
     is the same version as the search result that pointed at it. `publishedAt` is
     provider prose carried through unvalidated; no ETag, Last-Modified or content
     hash is compared between the search row and the fetched bytes.

  5. THE REAL PARSER OF A REAL PROVIDER'S PAGES. LINK 2/3/4 fetch a real socket,
     but the page is one the test served. HTML->markdown conversion is exercised
     (the real turndown path runs), but against a fixture page, not against real
     pages with real malformed markup.

  6. RANKING QUALITY. The port maps and dedups; it does not rank, and nothing here
     claims result quality. `mapHits` preserves provider order.

  7. THAT SEC-04'S GUARD IS AN EGRESS BOUNDARY. It is not, and this slice relies
     on that only in the sense that it uses the provider's documented seam. The
     guard's non-boundary status is another agent's finding and is not re-measured
     here.

  8. LIVE COST/QUOTA BEHAVIOUR. Nothing about rate limits, 429 handling, or quota
     exhaustion was exercised, because no live call was made. A 500 is covered
     (LINK's failure shapes); a 429 is not separately covered.


-------------------------------------------------------------------------------
ROWS FOR docs/GAPS.md -- NOT APPLIED, for the owner of that file to paste
-------------------------------------------------------------------------------

Not edited, per instruction. The exact rows this slice would add:

```markdown
| G-WEB-01 | The ported web-search provider is MOUNTED but NOT SELECTED in the composed profile: `packages/dsh-daily-work/cordis.patch.yml` inserts `daily-web-search` (id `daily-search`), but the shipped `web` row sets `searchProvider: deepseek-official` and nothing overrides it, so `ctx.web.search` resolves to a different backend. | OPEN — finding | Verified through the REAL resolver (`loadProfile`/`composeEntries`) and at the seam. Evidence: `qualification/results/R6-research/resolver-reachability.txt`, test `LINK 1c` in `src/research-chain.test.ts`. "Reachable" is true; "wired to the model's web_search" is not. Resolving it means either overriding the `web` row (a product decision) or softening the M7.1 claim. |
| G-WEB-02 | The ported provider's wire dialect does not match the endpoint the product configures: the port sends `{query, maxResults}` with NO credential header and reads `snippet`/`publishedAt`, while `https://api.exa.ai/search` expects `{query, type, contents, numResults}`, requires `authorization: Bearer`, and returns `highlights[]`/`publishedDate`. | OPEN | Measured through the shipped `mapHits` (tests `LINK 1b`, and `web-search.test.ts`). Consequence: the live half of R01 is blocked by a CODE gap (no adapter exists) on top of `live_provider_budget_authorized: false`. Authorizing a budget would NOT make the configured row work, so R01's live half must not be recorded as PASS even if a budget is granted. DSH ships correct providers for both dialects (`@deepseek-ai/dsh-web-search-exa`, `@deepseek-ai/dsh-web-search-deepseek`); reusing one would be a product change. |
| G-WEB-03 | No version identity is established between a search result and the bytes fetched from it. `publishedAt` is provider-supplied and carried through unvalidated; no ETag, Last-Modified or content hash is compared across the discovery->retrieval step, so a page that changed in between is cited as though it had not. | OPEN | R01's oracle says "each step carries a real source and a version". The source is now digest-verified (LINK 4); the version is not. `provenanceFromFetch` has `etag`/`lastModified` fields but no production caller populates them from a search result, and `searchProvenance` records no version at all. Evidence: `qualification/results/R6-research/FINDINGS.md`. |
```

And one line for the existing TODO table, since G-TODO-09 is now answerable:

```markdown
| G-TODO-09 | Whether the zloop web-search dual-lane layer can be ported as a DSH plugin. | RESOLVED — with a scope limit | The DISCIPLINE ported (failure-is-never-empty, presence-only availability, canonicalization, drop-rows-without-URL) and is tested. The dual-lane fan-out and browser-session transport did NOT port and are not needed for the seam. The port's dialect does not match the configured Exa endpoint (G-WEB-02) and it is mounted but not selected (G-WEB-01). Evidence: `qualification/results/M7.1-web-search-port/`, `qualification/results/R6-research/`. |
```


-------------------------------------------------------------------------------
WHAT THIS SLICE DID NOT DO
-------------------------------------------------------------------------------

  - No live search. No outbound request. No credential value read, printed or
    logged.
  - No edit to `web-search.ts` or `web-search-plugin.ts`. Both were mutated
    temporarily to test the oracle's strength, then restored and re-hashed to the
    digests above.
  - No edit to `cordis.patch.yml` or `package.json`. Both are SHARED; nothing was
    added to either.
  - No edit to `docs/GAPS.md`; the rows are in the fenced block above.
  - No edit to any file outside this slice's ownership, including
    `sec-gates.test.ts` (SEC-04 is another agent's; it is explained, not edited).
  - No commit, no push.
  - No test deleted, skipped or loosened; no N lowered; no permission widened.
  - No `as any`, no `as never` added to silence a real type error, no `!` added
    to hide a genuine `undefined`. Every non-null assertion introduced while
    writing the new tests was replaced with an explicit `expect(x).toBeDefined()`
    plus an early `return`, so a genuinely absent value fails with a clear message
    instead of being suppressed into a type assertion. (The pre-existing `as never`
    casts on `ctx.plugin(...)` are the file's established idiom for plugin
    registration and were not introduced here.)
  - The whole suite was NOT run. Only this slice's three files were, per
    instruction, because other agents are working in the tree.
  - Every loopback server this slice started was closed in `afterEach`; a
    before/after `netstat` diff across a full run showed NO new listening port,
    and port 3080 is free.
