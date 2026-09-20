# Round-3 re-measurement of cases whose recorded FAIL predates this round's fixes
# measured by root, from the full serial suite run of 2026-09-20 (89 files, 1672 tests)
# raw suite log: SERIAL-DEFINITIVE.txt (worktree root)
# built product: both packages rebuilt before the run (tsc exit 0, lib/ newer than src/)

== IPY-13 clause 1: a post-return write is late/unattributed and never rides a later cell ==
[V3-MEASURED] IPY-13-clause1 {"lateCount":1,"lateText":"IPY13-LATE-AFTER-RETURN","lateCellId":"f9c32e13-edbb4d00a62c0f4fd8e061fc_30432_2","lateEpoch":1,"firstCellContainsLateText":false,"secondCellContainsLateText":false}

  READING: lateCount 1, lateCellId carries the ORIGINATING cell, and BOTH the first and
  the second cell report containsLateText false -- so the post-return write rode no later cell.
  CLAUSE 1 HOLDS.

== IPY-13 clause 2: a write DURING a later cell is undecidable, not attributed ==
[V3-MEASURED] IPY-13-clause2 {"specRequires":"reported as undecidable rather than attributed","measuredAttributedToLaterCell":false,"measuredLateCount":1,"measuredLateText":"IPY13-DURING-LATER-CELL","thirdCellStdout":"tick 0\ntick 1\ntick 2\ntick 3\ncell-three-settled","mechanism":"ipykernel iostream resolves the parent from a contextvar with a process-wide global fallback; a threading.Thread has an empty context, so the kernel stamps the LATER cell id. The broker-side bootstrap now carries the originating cell header into cell-started threads and sentinels the rest.","verdict":"clause_met"}

  READING: measuredAttributedToLaterCell FALSE and measuredLateCount 1, and the third cell's
  stdout is ONLY its own ticks -- the marker IPY13-DURING-LATER-CELL does not appear in it.
  The oracle requires 'reported as undecidable rather than attributed'; the measurement's own
  verdict field reads clause_met. CLAUSE 2 HOLDS.

  NOTE ON THE MECHANISM, recorded because the recorded FAIL cited the opposite: the old note
  said the write WAS attributed because ipykernel resolves the stream parent from a contextvar
  with a process-wide global fallback and a threading.Thread starts with an empty context.
  The measurement now reports the broker-side bootstrap carries the originating cell header
  into cell-started threads and sentinels the rest. The upstream behaviour is unchanged; what
  changed is that the broker no longer accepts the global fallback as an attribution.

== CAP-10: a completion storm neither duplicates nor misses a top-up ==
  measured by writer c7 against the V8 probe arm that ORIGINALLY measured the defect:
V8/CAP-10 measured: freedSlots=2 concurrentRequests=3 admitted=2 heldAgainstTarget3=3 acceptedIds=["child-70","child-71"] deficitAfter=0
 Test Files  1 passed (1)
      Tests  1 passed | 3 skipped (4)

  BEFORE (recorded FAIL): freedSlots=2 concurrentRequests=3 admitted=3 -- four tasks holding
  slots against a target of three, and capacityDeficit read 0 so the overshoot was invisible.
  AFTER: admitted=2, heldAgainstTarget3=3, deficitAfter=0. NO OVERSHOOT. The oracle holds.

  The fuller storm suite (qualification/results/C7-remeasure/cap10-storm-full.txt) adds:
  target=6 freedSlots=6 admittedInStorm=5 +1 on retrigger = 6 held, overshoot=0; a control arm
  (admitted=6 held=6 overshoot=0); an N+2-against-N arithmetic arm (admitted=6 launches=12
  highWater=6); a duplicate arm; and a sweep across freed 3/5/10 of 10, all overshoot=0.
  7/7 passed. Fixed by 654bace (generation/dirty leader loop replacing the buggy coalescer).
