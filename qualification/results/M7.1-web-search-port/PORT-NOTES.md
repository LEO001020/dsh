=== M7.1: the zloop web-search layer ported to DSH ===

SOURCE (read-only, not modified):
  E:\zcode-labs\zloop\plugin\runtime\src\zloop\lanes.py
  E:\zcode-labs\zloop\plugin\runtime\src\zloop\websearch.py

PORTED (the discipline that carried meaning):
  - a failed provider is UNAVAILABLE, never 'no results'. Zero hits from a
    working provider is an empty source list; a provider that could not
    answer is an error. Collapsing them fabricates evidence.
  - available() is presence-only and makes NO network call, because
    configuration presence is not a tested entitlement.
  - canonicalization strips the fragment and known tracking params, refuses
    embedded credentials and non-http(s), and does NOT lowercase or fold
    trailing slashes, because over-normalizing merges distinct pages.
  - rows with no usable URL are dropped rather than emitted as a citation
    to nothing.

NOT PORTED, deliberately:
  - the Luna+Kimi dual-lane fan-out and the consumer browser-session
    transport. Those depend on a Python credential layout DSH does not have.
    A second lane is a second provider registration, not a rewrite.

INTEGRATION POINT: ctx.web.registerSearchProvider, so dsh-tool-web's
existing web_search tool routes to it. ONE tool definition, one registry;
this adds a provider, not a second tool and not a second result shape.

VERIFICATION:
  tsc --noEmit exit 0
  24 web-search tests, 111 tests total across seven files
  Includes an end-to-end test THROUGH ctx.web.search() with selection
  configured by id: WEB_PROVIDER_CONFIGURED_MISSING before mount,
  WEB_PROVIDER_CONFIGURED_UNAVAILABLE after mount with no credential store
  (the honest presence-vs-entitlement state), MISSING again after unload.

NOT PROVEN: a real search against a live provider. No search credential is
configured, and a key being present would not authorize paid evaluation.
