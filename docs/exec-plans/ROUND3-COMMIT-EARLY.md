# ROUND 3 — COMMIT EARLY. THIS IS NOT A STYLE PREFERENCE.

## The measured problem

Five slices in round 3 have been lost to model errors. Every one produced
**NOTHING** — no commits, no modified files, no evidence:

| slice | time before failure | what survived |
|---|---|---|
| P13 (first attempt) | ~60 s | nothing |
| P7 (first attempt) | ~70 s | nothing |
| P5 (first attempt) | ~7 min | nothing |
| S7 (round 2, first attempt) | ~23 min | nothing |
| S5 (round 2, first attempt) | ~26 min | nothing |

The pattern is not random. A slice that reads source and plans a large edit
without committing loses everything when the model call fails. A slice that
commits after each step loses only the current step.

**Counter-evidence, same wave:** P13's retry was given an explicit "commit after
every step" instruction and committed within its first few minutes. The
instruction works.

## The rule

**After your FIRST concrete artifact — one source finding, one measurement, one
file changed — commit it.** Then repeat: one step, one commit.

A step may be as small as a file under `qualification/results/<your-slice>/`
recording what you read and where. That is a legitimate commit. It is
incomparably more valuable than an uncommitted plan, because the plan is
invisible to everyone if the call fails.

## What to do if you are running long

**Commit what you have and report it as PARTIAL.** Name the step you reached and
what remains. A partial committed result lets the next writer or the integrator
continue from it. An uncommitted complete result helps nobody.

This is not a suggestion about tidiness. It is the single highest-value
behavioural instruction in this wave, and it is written down because it has now
cost this project five slices across two rounds.
