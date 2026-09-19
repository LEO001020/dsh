=== M9.16: research gates R01, R02, R05, R07 ===

ARTIFACT: packages/dsh-daily-work/src/research-chain.test.ts
  29 tests, 1 file, all passing. tsc build config exit 0.
  sha256 424226da9bab3a153cb9ae1572dd09dc4ee1ce77d5231408b7f97142cf0ab3ae

  SUBJECT UNDER TEST, read-only, NOT edited by this slice:
    src/web-search.ts        8d6ec8fca407daba46f7cde629d7a3d4ff8d00418746fa9806c14d7ba2226649
    src/web-search-plugin.ts 1ede5df10b05e0afdb5a9840ad046a034389bdfe1a108d68b38af77cc1d05350

  The plugin file changed under this slice while it ran (another agent added
  `credentialRef`, which validates the reference name). The slice was re-read and
  the tests re-run against the new content; the hash above is what was tested.


-------------------------------------------------------------------------------
RESULT PER GATE
-------------------------------------------------------------------------------

  R01  PASS OFFLINE for the four links and all seven failure shapes.
       NOT fully closed: the live search-API contract is BLOCKED_EXTERNAL.
       Recommended status: PARTIAL, or BLOCKED_EXTERNAL for the live link.
       It must NOT be recorded as a full PASS.

  R02  PASS. The tier vocabulary cannot express `primary_read` or `understood`,
       and the only mutator requires a named transition with its own evidence.

  R05  PASS. Two orderings are distinguished on the production loop, on the wire
       and in the response index, with one finding recorded (the naive seq
       predicate is wrong for exclusive tools) and the non-prover boundary
       asserted rather than implied.

  R07  PASS. Both stimuli measured on the dispatched `GenerateOptions`, with the
       request assembly quoted and the estimate-versus-wire distinction
       demonstrated.

  gates.json is NOT edited by this slice -- it is the dispatcher's to record, and
  another agent is writing it. At capture time it still read R01/R05/R07 as
  NOT_RUN and R02 as PASS; the evidence above is what would move them.


-------------------------------------------------------------------------------
THE OFFLINE / BLOCKED_EXTERNAL SPLIT
-------------------------------------------------------------------------------

Every gate below is closed OFFLINE except for exactly one link, named in R01.
The split is not a caveat appended to a green light; it is asserted per test.

  PROVEN OFFLINE (no live provider, no paid API, no key):
    - the ported search provider's request shape, error codes and mapping
    - ctx.web's provider selection and its four refusal codes
    - dsh-tool-web's schema, validation and model-facing rendering
    - dsh-web-fetch-http's transport, SSRF guard, content-type boundary,
      byte/char caps and truncation labelling -- against a REAL loopback server
    - the production AgentLoop's tool scheduling and durable event ordering
    - the production SystemPrompt assembly and the dispatched GenerateOptions
    - the evidence-tier transition system
    - the prompt-stability request diffs, measured on the adapter's requests

  BLOCKED_EXTERNAL (needs a live search credential AND a budget authorization):
    - R01 LINK 1's counterpart: that a REAL search API answers in the shape the
      ported provider expects. The provider's own response mapping is exercised
      against a controlled fake; what is unproven is the third-party contract.
      compatibility.lock.json records live_provider_budget_authorized: false, so
      this stays BLOCKED_EXTERNAL and is NOT counted as a PASS.

  No outbound request left this machine. The only sockets opened were loopback
  HTTP servers created by the tests themselves.


-------------------------------------------------------------------------------
R01 -- the real search chain
-------------------------------------------------------------------------------

Stimulus: independent retrieval -> original fetch -> complete relevant range ->
citation. Oracle: every step carries a real source and version; a missing key or
a failed fetch fabricates no result.

The chain is four links, and they are proven against DIFFERENT substrates. That
is the honest shape of the evidence, so each link says which it is.

  LINK 1, retrieval -- CONTROLLED FAKE.
    A loopback HTTP server answers the ported provider's request shape. The test
    asserts the request that actually left the process (`{query, maxResults:60}`
    at the configured endpoint), that a tracking parameter is stripped and a
    duplicate collapsed to one citeable URL, and that the model-facing text
    carries a markdown link. PROVEN: our provider, the seam, and the tool.
    NOT PROVEN: that a real search API returns this shape. BLOCKED_EXTERNAL.

  LINK 2, original fetch -- REAL NETWORK, LOOPBACK ORIGIN.
    The shipped `HttpFetchProvider` retrieves a real page over a real socket,
    and the model sees the ORIGINAL bytes converted to markdown, not a summary.

  LINK 3, complete relevant range -- REAL NETWORK.
    A body cut by the character cap comes back flagged `truncated: true` with a
    "Content truncated" footer, and the dropped text is absent from the output.
    "Complete relevant range" means the caller can TELL it is incomplete; a
    silently shortened body is what this asserts against.

  LINK 4, citation -- REAL NETWORK for the fetch, controlled fake for the search.
    The search returns three rows: one with no URL, one with a `javascript:`
    URL, one valid. Only the valid one survives, with its `publishedAt` visible
    in the model-facing text -- and that SAME URL is then fetched for real, so
    the citation names a page this process actually retrieved.

The "failed is never empty" rule is asserted from BOTH sides, which is the only
way to pin it. Four failure shapes, each an explicit error with its own code and
no "No results found." in the output:

  - no credential configured   -> WEB_PROVIDER_CONFIGURED_UNAVAILABLE
                                  (and ZERO requests were attempted: `hits == 0`,
                                  `server.requests == []`)
  - provider answers HTTP 500  -> an error whose message names the status
  - endpoint unreachable       -> SEARCH_PROVIDER_UNAVAILABLE, a DIFFERENT code
                                  from the 500, because a caller acts differently
  - no fetch provider mounted  -> WEB_PROVIDER_UNAVAILABLE, value undefined
  - fetch refused by the guard -> WEB_BLOCKED_URL, value undefined

...and the complement, so the distinction is pinned from the other side too:

  - a WORKING provider that genuinely finds nothing -> `sources: []` and the
    text "No results found." This is an honest answer, not an error.

One more failure shape matters for R02 and is recorded here:

  - a PDF is REFUSED at the content-type boundary with
    WEB_UNSUPPORTED_CONTENT_TYPE. `classifyContentType` (policy.ts:78) returns
    undefined for `application/pdf`, so the shipped fetch provider CANNOT turn a
    PDF into a "read" through this path at all. R02's scenario is therefore about
    a caller that captured bytes some other way, not about this provider quietly
    pretending. The test asserts no `%%EOF` appears anywhere in the result.

The SSRF guard is exercised with its SHIPPED resolver for four addresses
(127.0.0.1, localhost, 169.254.169.254, [::1]) and refuses all four with
WEB_BLOCKED_URL. Where a test must reach loopback, it passes the provider's own
documented second constructor parameter -- `HttpFetchResolver`, documented in
network.ts:33 as the signature "used to test public-address policy without
process DNS changes" -- rather than monkeypatching a module. The guard is
narrowed for one test, not disabled.

RESULT: R01 PASS OFFLINE for the four links and every failure shape; the live
search API contract remains BLOCKED_EXTERNAL.


-------------------------------------------------------------------------------
R02 -- evidence tiering
-------------------------------------------------------------------------------

Stimulus: PDF bytes are saved and the body was never presented to the root.
Oracle: labelled `bytes_captured`, NOT `primary_read` / `understood`.

The tier vocabulary is taken from the delivery plan's own words
(MASTER_EXECUTION_PROMPT.zh-CN.md:416-419): discovered; bytes_captured; parsed;
range_presented_to_model; cited_in_output; manual/automatic_support_checked --
"there is no automatic model_understood".

"IMPOSSIBLE TO DO ACCIDENTALLY" is implemented as two independent barriers:

  1. COMPILE TIME. `EvidenceTier` is a union of six literals. `understood` and
     `primary_read` are not members, so a promotion to either is not merely
     refused -- it is unspellable without a cast.
  2. RUNTIME. The only mutator is `advanceEvidence(current, transition)`, which
     takes a NAMED transition carrying its own justification. There is no
     overload that takes just a target tier. It refuses:
       - a skipped step (bytes_captured -> range_presented_to_model)
       - a backwards step (parsed -> bytes_captured)
       - a transition with no stated observation
       - a `parsed` transition that does not state its coverage
       - a later rung that tries to rewrite the parse's coverage

The test executes both barriers. It asserts `EVIDENCE_TIERS` does not contain
`understood`, `primary_read`, `read` or `summarized`; that advancing to either
of the first two throws `EvidenceTransitionError`; that re-capturing bytes any
number of times leaves the tier at `bytes_captured` (there is no counter that
eventually promotes); and that walking the whole legal ladder ends at
`support_checked`, whose transition list is empty.

The coverage rule is the subtle part and is stated as its own test. A `parsed`
transition MUST declare `complete | partial | none`, because "parsed" is the
first tier that asserts anything about the CONTENT, so it is the first place a
coverage claim can be smuggled in by omission. Later rungs may not restate it --
otherwise a `partial` parse could be silently upgraded to `complete` while the
tier is promoted. The ladder test carries `partial` from rung to rung and
asserts it survived.

A NOTE ON WHAT IS AND IS NOT DSH API HERE. DSH has no evidence-tier concept to
import. `EvidenceRef` in record.ts is a POINTER (`kind`/`id`/`digest`): it
answers "where is it", not "how far did we get with it". Inventing a DSH API for
this would be the fabrication the task forbids, so the tier is modelled in the
test file against the plan's own vocabulary. The gate's claim is about the TYPE
SYSTEM -- that the promotion is impossible to make accidentally -- and that claim
is true of the type as written.

RESULT: R02 PASS OFFLINE.


-------------------------------------------------------------------------------
R05 -- sampling after real observation
-------------------------------------------------------------------------------

Stimulus: the result has not returned, yet the SAME response already contains a
dependent effect's parameters. Oracle: the two orderings are distinguishable in
a controlled case; and this is NOT a general semantic-dependency prover
("普通语义依赖审计不装普遍证明器").

Two orderings are constructed on the production AgentLoop and distinguished.

  ORDERING A, SAME RESPONSE. One assistant message asks for both `probe` and
  `effect`. Both calls therefore came from response 0, read off the adapter's own
  recorded output. The effect's parameters were fixed before the observation
  could have returned.

  ORDERING B, OBSERVED THEN SAMPLED. The probe is asked for in response 0, the
  effect in response 1. There is a request that carried the observation and NOT
  the effect.

  THE WIRE FORM OF THE DISTINCTION, which is the register that does not depend on
  trusting the adapter's bookkeeping:
    A: the observation and the effect's parameters first reach the provider in the
       SAME request (index 1 for both).
    B: the observation first reaches the provider at request 1, the effect's
       parameters at request 2 -- and request 1 is asserted to contain the
       observation and NOT the effect.

FINDING, and the reason the naive predicate is wrong. The obvious predicate --
"was the effect's `tool/call` event logged before the observation's `tool/result`
event?" -- is WRONG, and the test demonstrates it rather than avoiding it. With
EXCLUSIVE (non-concurrency-safe) tools, `executeToolCalls` forms an exclusive call
into a group of ONE and awaits it to completion before appending the next call
(`const group = mode === 'parallel' ? planned.slice(next) : [first]`,
core/agent-loop/src/tool-calls.ts:90), so the second call's `tool/call` event is
appended AFTER the first call's result -- even though both came from one model
message. The naive predicate classifies that case as "observed then sampled" when
it is in fact "same response". The test asserts both verdicts side by side:
`naive(exclusive) === 'observed_then_sampled'` while
`classify(exclusive) === 'same_response'`, with the response index as the
tie-breaker of record. Anyone reading this gate off sequence numbers alone would
get the exclusive case backwards.

  This is a real finding about the subject, not a test artefact. It is also the
  reason the gate is closed on the RESPONSE index and on the wire, not on `seq`.

NOT A GENERAL PROVER, asserted explicitly rather than left implicit. Two cases
are constructed where the ordering and the dependency come apart:

  - a same-response pair whose effect parameters are a CONSTANT that never
    depended on the observation. The predicate reports `same_response`, and it is
    right about the ORDER; it says nothing about the dependency.
  - an observed-then-sampled pair with the SAME constant. The model could have
    chosen those parameters regardless.

  Same parameters, different orderings, and the runtime cannot tell whether
  either depended on the observation. The test asserts the two `effectArguments`
  are equal, so the boundary is visible in the artifact rather than hidden. The
  plan's limit is quoted in the comment: "runtime cannot prove every semantic
  dependency from the read-set the model declares"
  (MASTER_EXECUTION_PROMPT.zh-CN.md:423).

  What is NOT built, deliberately: no read-set parser, no dataflow analysis, no
  "this parameter came from that result" inference. The gate's oracle asks for
  two identifiable orderings in a controlled case, and that is all this closes.

RESULT: R05 PASS OFFLINE, with one finding recorded (the naive seq predicate is
wrong for exclusive tools) and the non-prover boundary stated in code.


-------------------------------------------------------------------------------
R07 -- prompt stability
-------------------------------------------------------------------------------

Stimulus: (a) only unrelated dynamic state was updated, (b) the tool ORDER
changed. Oracle: the ACTUAL REQUEST differences are explainable, and a cumulative
surface estimate is NOT used as a substitute for the wire fact.

HOW THE REAL REQUEST IS ASSEMBLED, quoted from the source this slice read.

  `ReactLoopAgent.buildRequest` (core/agent-loop/src/agent.ts:554-616) builds the
  canonical header and logs it:

      const header = canonicalHeader({
        config,
        ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
        ...tools.length > 0 ? { tools } : {},
      })
      const baseline = this.session.requestHeader()
      ...
      } else if (baseline === undefined || !headerEquals(baseline, header)) {
        this.session.append('request/header', {
          header,
          reason: 'change',
          ...startsSeries ? { startsSeries: true } : {},
        })
      ...

  and then derives the FROZEN request the adapter receives from that same header:

      const request = markAgentLoopRequest(Object.freeze({
        ...header.config,
        messages: boundaryMessages,
        ...header.tools !== undefined ? { tools: header.tools } : {},
        sessionId: this.session.id,
        signal,
      }))

  So the wire request and the logged header are built from ONE header value, which
  is why the logged header is a legitimate reconstruction rather than a guess --
  and also why it must still be checked against the wire rather than trusted in
  place of it.

  `headerEquals` (core/session/src/request-header.ts:38-51) is where order is
  decided to matter:

      /** Field-wise equality over canonical headers. Tool schemas compare in order. */
      ...
      return at.length === bt.length && at.every((tool, i) => sameSchema(tool, bt[i] as ToolSchema))

  `orderTools` (core/system-prompt/src/index.ts:216-230) is where registration
  order is discarded:

      if (toolOrder === undefined) return tools.sort(compareToolNames)

  with `compareToolNames` (line 243) a code-unit comparison, so the order is
  identical on every machine.

  `session.surface.contentGeneration` (core/session/src/surface.ts:229-230) is
  the cumulative quantity R07 warns against:

      /** Monotonic count of committed replacements and plugin-owned message changes. */
      readonly contentGeneration: number

  It counts committed REPLACEMENTS and plugin-owned message CHANGES. It does not
  count appends, and it says nothing about tools, config, or what was dispatched.

CASE (a), unrelated dynamic state. A `session/title` event is appended between
two turns. Measured on the adapter's requests:
  - the tool list is byte-identical, and the system node is byte-identical;
  - the roles go ['system','user'] -> ['system','user','assistant','user'];
  - the second request's PREFIX is byte-identical to the whole first request,
    message ids included, so the only difference is the new turn;
  - exactly ONE `request/header` event exists, reason 'initial', so the loop's own
    reconstruction agrees that nothing changed;
  - `isSurfaceEligibleType('session/title')` is false -- DSH's own exported
    predicate over the four message-producing types
    (core/session/src/surface.ts:50-64) -- so the event could not reach the
    surface by construction, and no `session/title` event carries `surfaceOp`.

CASE (b), tool ORDER. Three runs, and the two sub-claims are kept apart:
  - two runs registering the SAME three tools in different orders produce
    BYTE-IDENTICAL tool lists on the wire: ['alpha','mike','zulu'] both times.
    Registration order is a loading artifact and does not reach the wire.
  - a configured `toolOrder: ['zulu', REST]` produces ['zulu','alpha','mike'] on
    the wire, and the logged header agrees with it. The change is confined to the
    tool list: the system node and the message list are identical across all
    three runs.
  - mid-session, unregistering `zulu` and registering `mike` produces a SECOND
    `request/header` with reason 'change' and tools ['alpha','mike'], and the
    second request's tool list matches it. The header and the wire agree.

THE WIRE FACT IS NOT REPLACED BY AN ESTIMATE. A dedicated test constructs the
disagreement. It takes the session's own logged header and appends a `ghost` tool
that no request ever carried, then asserts `headerEquals(estimated, logged)` is
false and that the dispatched request does not contain `ghost`. It also reverses
the estimate's tool list and asserts `headerEquals` rejects that too -- order
matters to the comparison, so a reordered estimate cannot be shuffled into a
false match. The stability claim is then read off `adapter.requests[0]`.

  `contentGeneration` is deliberately NOT used as the stability measure anywhere
  in this file. It is the cumulative surface quantity the oracle names, and using
  it would be exactly the substitution R07 forbids.

RESULT: R07 PASS OFFLINE for both stimuli, with the request assembly quoted and
the estimate-versus-wire distinction demonstrated rather than asserted.


-------------------------------------------------------------------------------
WHAT THIS SLICE DID NOT DO
-------------------------------------------------------------------------------

- No live search. No outbound request. No key was read, and none is configured.
- No edit to web-search.ts or web-search-plugin.ts, host.ts, record.ts or
  counting.ts. The subject files were read only.
- No general semantic-dependency prover, and no claim that an ordering proves a
  dependency. See the R05 section.
- No change to qualification/gates.json. The gate statuses are the dispatcher's
  to record; this file reports what was measured.
- No claim that R01 is fully closed. Its live half stays BLOCKED_EXTERNAL.


-------------------------------------------------------------------------------
FULL-SUITE CONTEXT
-------------------------------------------------------------------------------

  $ vitest run --pool=forks --maxWorkers=1
    Test Files  3 failed | 31 passed (34)
    Tests       3 failed | 572 passed (575)

  All 29 research-chain tests passed inside that run. The three failures are in
  OTHER agents' files in this shared workspace, all of them mid-edit scratch or
  in-flight suites, and none touches this slice:
    src/terminal-advanced.test.ts   (T08 marker framing)
    src/u04-paired-comparison.test.ts
    src/__probe5.test.ts            (scratch probe)

  $ tsc -p tsconfig.json --noEmit            -> exit 0
  $ tsc -p tsconfig.check.json --noEmit 2>&1 | grep -c research-chain -> 0

  The check config type-checks EVERY test file in the workspace, so its aggregate
  result moves while other agents work. This slice's file contributes zero errors,
  which is verified by the count above rather than by the aggregate exit code.
  See tsc.txt for the full error list at capture time.
