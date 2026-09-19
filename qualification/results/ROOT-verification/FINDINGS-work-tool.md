# The `work` tool on the composed profile: measured, not read

## The claim

`docs/GAPS.md` G-SEAM-31 says nothing in the product creates a run, so the
model-facing `work` tool throws before it can admit anything. This is the
measurement.

## Method

A probe plugin (`/.probe/verify-work-tool-unusable.mjs`) inserted into a real
boot of the composed `daily` profile, from a foreign cwd
(`C:/Windows/Temp`), on a home installed after the preset-root fix
(`D:/DSH/home/root-m12-fresh`). It creates a real Session, then reproduces the
tool's own lookup **exactly** (`tools.ts:127-129`: scan `listRunIds()`, take the
run whose `rootSessionId` is this Session).

Result: `qualification/results/ROOT-verification/work-tool.json`.

## Result

| Step | Measured |
|---|---|
| Session created | yes, `session-ce481c01-…` |
| `dailyWork` service present | yes |
| `listRunIds()` | `[]` — **zero runs** |
| A run for this Session | none |
| So the tool throws | `this session has no active run; a run is created by user authorization` |

## The positive control, which is what makes this a real negative

A probe that only reports "nothing was found" cannot distinguish *the product
never creates a run* from *the probe's traversal is broken*. So the probe then
creates a run **through the real API** and re-runs the tool's exact lookup:

| Control step | Measured |
|---|---|
| Live agent for the Session | found |
| `service.createRun({root, authorizationRef, targetChildren: 10})` | **ok**, `phase: 'open'` |
| Tool's lookup AFTER the create | **finds it** |

So the traversal works, the service works, and `createRun` works when called.
The only thing missing is a caller in the product. That is the finding.

## Two errors this probe made before it measured anything, both recorded

1. **`sc.create()` returns an id, not a Session object.** The first run died with
   `Cannot read properties of undefined (reading 'header')`. Fixed by reading
   `created?.sessionId ?? created?.id`, the same access the working M12 probe
   uses.
2. **`listRuns()` does not exist; the API is `listRunIds()` + `getRun(id)`.** The
   first version guessed `listRuns`, found `undefined`, and therefore reported
   `toolWouldThrow: true` **for a reason that had nothing to do with the claim** —
   an empty negative. That is exactly the failure the positive control now
   guards, and it is why the control is part of the probe rather than a note
   beside it.

## What this does NOT say

It does not say the N=10 capacity work is wrong. The capacity arithmetic, the
rolling refill and the launch port are all real and tested — `2d4534f` wired
`installDefaultLaunchPort(root)` at `createRun`, and `production-port.test.ts`
proves it by installing nothing. What is missing is the **entry point**: the
product never calls `createRun`, so that correct mechanism is unreachable by any
user action.

It also does not propose a fix. Inventing a caller would fabricate the
user-driven authorization edge that the tool's own error message names. The
honest options are a real user-authorized entry point, or recording that daily
use cannot start managed work — and that decision belongs to the delivery, not
to a probe.
