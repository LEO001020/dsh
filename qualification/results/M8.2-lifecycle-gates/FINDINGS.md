=== M8.2: lifecycle gates closed with real evidence ===

C08 disposal failure -- the fact this is built on, from the DSH source
(packages/subagent/subagent/src/lifecycle.ts:189-194):
  'Teardown failure overrides the epoch own outcome and withholds its output:'
  'an answer this harness could not durably release is not a result.'
  const terminal = (failure) => failure === undefined ? captured : {stopReason:'error'}

So a subagent/end can carry stopReason 'error' BECAUSE DISPOSAL FAILED, not
because the work failed. Those two readings have opposite consequences:
  work failed     -> child is gone; slot may be released
  disposal failed -> child may exist; slot MUST be held

PROVEN:
  - the real registry emits end events whose ONLY failure signal is stopReason:
    SubagentRunEndInfo has no error field and no diagnostic. Asserted directly.
  - an end event alone does NOT release a slot. After the child ended, the task
    was still 'accepted', the reservation still 1, the deficit unchanged.
  - a disposal-failure-shaped window reconciles to unknown, never to
    failed-and-retryable.
  - a cancel that is only REQUESTED still holds its slot and its credit.

C17/C18 pause versus drain -- both asserted against the REAL seam:
  - pause closes admission and RESUME STILL WORKS. That is the property that
    proves pause did not use drain.
  - a real drainContinuableDescendants DOES close admission for that exact
    parent permanently; a later startContinuable is rejected. This is why drain
    is reserved for final close.
  - closing a run (the model finish action) stops new admissions while leaving
    the family open, so a failed acceptance remains recoverable.
