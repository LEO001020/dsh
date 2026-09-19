=== M8.3: wire-level provider faults (C09, D07) ===

METHOD: @deepseek-ai/dsh-llm-mock-server, which is a scriptable
OpenAI-compatible HTTP/SSE server, NOT a model adapter. Using it means the
fault travels the genuine wire path: real sockets, real status codes, real
truncated streams. A stub that throws would not exercise the same code.

C09 rate limiting:
  - the mock really answers 429 with a Retry-After; verified on the wire
  - the mock really answers 500 and 401 for server_error and auth_error
  - a 429 keeps desiredTarget at 10 and REPORTS a deficit. A provider limit
    is never answered by quietly lowering N.
  - an exhausted script answers 500 MOCK_SCRIPT_EXHAUSTED rather than
    silently succeeding, so a suite cannot be green for the wrong reason

D07 lost reply:
  - the mock really drops a stream mid-flight (no [DONE] delivered)
  - the mock really accepts a request and never completes it
  - in that window the reconciler returns unknown and holds the reservation
  - IMPORTANT DISTINCTION, asserted explicitly: reconciliation returns a
    DECISION, it does not write. The stored state stays 'executing' until a
    caller applies the decision, and quarantinedUnknown counts STORED state.
    The slot is held either way, which is the property under test.
  - every fault-shaped evidence record resolves to unknown or a conservative
    earlier state. None resolves to a released slot, so a transport failure is
    never treated as evidence about the world.
