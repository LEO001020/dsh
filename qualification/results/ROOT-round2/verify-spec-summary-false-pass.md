# `verify-spec.py --summary` exits 0 while the full check exits 1

Found by writer S3 during the identity adoption; independently re-measured here
with the exit codes captured without a pipe in between.

## The measurement

```
$ python qualification/runners/verify-spec.py --summary  > out 2>&1 ; echo $?
0
$ python qualification/runners/verify-spec.py            > out 2>&1 ; echo $?
1
```

The full path reports:

```
verify-spec: 317 problem(s).
```

and the summary path reports an UNCHANGED, GREEN tally:

```
BLOCKED_EXTERNAL=1, FAIL=13, PASS=95
```

## Why this is the worst shape of gate defect

The project's most-recorded defect class is "mechanism implemented, tested,
correct -- while nothing in the product calls it". This is its qualification-side
twin, and it is worse than a missing check:

- the summary is not WRONG about what it prints (the tally really is 95/13/1), but
  it prints a PASS-shaped line and exits 0 **while 317 binding problems exist**;
- a CI step, a script, or a reader that runs `--summary` gets a green light and
  stops. The `0` is what a gate consumer reads, and it is the number that lies;
- the trap is silent in the direction that matters: nothing distinguishes "no
  problems" from "problems not looked for on this path".

## What the 317 are

All 317 are identity-binding staleness: evidence filed under the superseded
deployment identity `0a0996f3…` while the lock now records `533c8cb0…`. They span
**27 distinct cases** (`ID-01…ID-06`, `CMP-01…CMP-14`, and the `IPY` family). The
script prints only the first 80 and then `... and 237 more`, which is why a
`grep -c "  - "` undercounts — the count must be read from the script's own
`N problem(s).` line, not from the visible list.

This is EXPECTED after an identity adoption and is not itself a defect: every one
of those verdicts is now stale as *evidence*, which is exactly what the identity
mechanism is for. The defect is the summary path's exit code, not the staleness.

## The verdict

`--summary` must not exit 0 while the full path exits non-zero. Two honest fixes
exist and the choice is a real one, so it is stated rather than made:

1. `--summary` exits non-zero whenever problems exist, and prints the problem
   count alongside the tally. The tally then reads "95 PASS, 13 FAIL, and 317
   binding problems" instead of looking clean.
2. `--summary` keeps exiting 0 but is RENAMED to say what it is (a tally printer,
   not a check), so nothing can mistake it for a gate.

Option 1 is preferred: the tool is named `verify-spec`, and a verify tool that
exits 0 is a gate by convention whether or not it means to be.

## Not fixed here

`qualification/runners/verify-spec.py` is not owned by this note's author and S3
documented the trap rather than changing a runner it does not own. That restraint
is correct. The fix is routed to a writer who owns the file, with this measurement
as the evidence.
