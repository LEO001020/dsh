# M9.21 — is the exact-owner guard actually mounted in the composed profile?

**Status: PASS. The guard IS mounted and DOES deny a stale owner.**

## Why this probe exists

The `work` tool resolves a run for a calling Agent by **string** comparison of the
session id (`src/tools.ts`). A SessionId is reused across an agent's life:
`AgentRegistry.resume` publishes a NEW Agent object under the SAME id, so a
callback holding the PREVIOUS lifecycle's object passes the string test and
writes authoritative state into the run the new lifecycle now owns.

`src/tool-protocol-guards.ts` closes that with object-identity comparison
mirroring DSH's own `TerminalSessionService.isLiveOwner` and the `jobs-local`
owner check, registered through `ctx.tools.guard` — the MONOTONIC slot, where a
later `tools/pre-execute` listener cannot restore permission.

But a correct module that the profile never mounts protects nothing. This
project already made that exact mistake once (B02/B03: green direct-mount tests
while the resolver loaded nothing), so the module's correctness is not the claim
under test here. **The claim is that the composed profile mounts it.**

## Result

```
atApplyTime:       null          <- the probe's own row applied first
guardMounted:      true          <- after the graph settled
forgedOwnerDenied: true
denialReason:      agent "session-forged-by-probe" is not the registered agent
                   instance: the session was replaced by a newer lifecycle, so
                   this call carries a stale owner and cannot write
                   authoritative state
honestPathAllowed: true          <- an ownerless call is left to the tool body
otherToolUntouched:true          <- a different tool is unaffected
```

The two controls matter as much as the denial. A guard that denied everything
would also "deny the forged owner" while breaking every other tool, so the probe
records that an unrelated tool passes through untouched, and that an ownerless
execution is left alone (the tool body names a missing owner far better than a
generic guard reason can).

## The diagnosis, including two of my own errors

Getting here took three probe iterations, and both dead ends were mine:

1. **I read `tools.guards`** to count registrations. That property does not exist
   on `ToolRuntime` — it lives on the internal layer (`ToolLayer.guards`,
   `packages/core/tools/src/index.ts:719`). The read returned `undefined`, which I
   briefly treated as evidence of absence. It was evidence of nothing.

2. **I concluded "the guard is not mounted"** from a `null` reason at apply time.
   That was wrong, and the way it was wrong is worth recording: **Cordis activates
   rows in service-availability order, not source order** — the base bundle's own
   header says "Row order carries no load semantics (activation is
   service-availability driven)". My probe's row was applied *before* the guard
   row it was asking about, so it observed a moment, not a composition. The probe
   now re-checks until the graph settles, and records `atApplyTime` alongside the
   settled verdict so the distinction is visible in the evidence.

A third check ruled out the module itself: importing it directly and calling
`apply(ctx)` made the guard deny immediately, proving the module was never the
problem.

## What this proves

- The composed `daily` profile mounts `dsh-daily-work/tool-protocol-guards`.
- The mounted guard denies a forged owner on the `work` tool, and leaves both an
  unrelated tool and an ownerless call untouched.
- Therefore B04's production closure is complete for the in-process resume case.

## What this does NOT prove

- **The `epoch` field is still inert.** `record.ts` documents it as the
  reject-on-stale point, but no code reads or writes it after
  `initialRunRecord` sets it to 1. Object identity covers an in-process resume; a
  run re-adopted across a **process** boundary has no enforcement today. Recorded
  in the tool-protocol FINDINGS and in `docs/GAPS.md`.
- This probe drives `guardReason` directly. It does not run a full model turn
  through the tool pipeline, so it proves the guard stage's verdict rather than
  the end-to-end refusal a model would experience.
