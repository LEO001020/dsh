=== M9.9: signal layering (B09) and turn-stopping cancellation (F06) ===

Test file: packages/dsh-daily-work/src/signal.test.ts — 14 tests, all pass.
Evidence:   tests.txt (test_exit=0), tsc.txt (both checks exit 0),
            source-digests.txt (project files + the pinned DSH sources quoted).

Result summary: B09 PASS (partially, see the honest scope note). F06 PASS.


--------------------------------------------------------------------------
B09 — signal layering
--------------------------------------------------------------------------

THE PROBLEM THIS GATE EXISTS FOR

An AbortSignal in this system means at least four different things, and
confusing them is how a system loses published work or keeps working after
its owner stopped:

  caller stopped waiting  -> the WAITING ends; the published work does not
  admission was refused   -> nothing was published; there is no ghost to kill
  the owner stopped       -> the product contract stops the work
  the turn was aborted    -> a clean abort, not a new correction round

SCOPE — READ THIS BEFORE QUOTING THE PASS

The gate's stimulus names three layers around a PUBLISHED BACKGROUND JOB.
This project publishes no background jobs: `grep -rn "ctx.jobs" src/` over
the package finds nothing, and the daily-work-host patch mounts no producer.
So the Job-layer claims below are made against the REAL `JobRegistry`
(`@deepseek-ai/dsh-jobs-local`), mounted and driven directly — NOT against
this project's own product path. That registry is genuine and the contract
asserted is the documented one, but "the registry behaves correctly" is not
the same claim as "this project publishes work through it correctly".

The layers that DO exist in this project are asserted against the real
`WorkService.drain` and the real `LaunchPort`. Those are the project's own
code and the PASS there is unqualified.

(a) ABORT BEFORE PUBLICATION -> NO GHOST JOB

  PROVEN, on this project's code:
    - `drain` handed an already-aborted signal launches NOTHING and returns
      an EMPTY outcome list, not a list of refusals. The guard is
      `if (signal.aborted) break` at the top of the per-request loop
      (src/host.ts:518), so nothing was ever considered.
    - No task record, no reservation, no consumed slot. `capacityDeficit`
      stays at the full target.

  PROVEN, on the real registry:
    - A producer that refuses a pre-aborted call BEFORE `jobs.start` publishes
      no record AND consumes no id: the next successful start is still
      `bash-1`. This mirrors tool-bash, which checks `exec.signal.aborted`
      (packages/shell/tool-bash/src/index.ts:358) before calling `jobs.start`
      (:364), per docs/cookbook/adding-a-tool.md:53,55.
    - Two distinct pre-publication failures allocate nothing and never run
      the producer body: a throwing `run()`, and the registry's own preflight
      refusal ("no job controller serves this agent"). Contract:
      packages/jobs/jobs/src/index.ts:74-78 — "Any preflight rejection leaves
      no job id or execution resource. A throwing starter leaves nothing
      registered; after it returns, registration cannot fail."

  STRUCTURAL FACT WORTH RECORDING: `JobStart` carries NO signal field at all
  (packages/jobs/jobs/src/types.ts:46-69). The registry cannot be asked about
  a pre-aborted call, because the refusal happens one layer ABOVE publication.
  Asserted at compile time in the test, so a future `signal` field on
  `JobStart` fails the build rather than silently moving the rule.

(b) CALLER ABORTS AFTER PUBLICATION -> THE WORK IS NOT LOST

  PROVEN, on this project's code:
    - Aborting mid-drain stops further launches and rolls NOTHING back. The
      signal is checked only BETWEEN requests, so an abort can never un-admit
      a task past its atomic reservation. The admitted task keeps its slot
      and its credit (`reserved: 1`), is not tombstoned, and the run stays
      `open` — the abort of the WAIT did not close admission.
    - The EXACT caller signal object reaches `LaunchPort.launch` and then
      `startContinuable` — asserted by object identity, not by behaviour.
      A wrapper that built its own AbortController would pass every
      behavioural test above while silently decoupling the caller's abort
      from the work.

  PROVEN, on the real registry:
    - Aborting a caller WAIT rejects the wait ONLY. The producer's `cancel`
      is never called, the status stays `running`, and the job later settles
      normally with its output still readable. Contract:
      packages/jobs/jobs/src/index.ts:122-124 — "Wait for settlement or
      timeout without cancelling the job. Caller abort rejects only while the
      job is live."

(c) THE REAL OWNER STOPS -> THE CONTRACT STOPS THE WORK

  PROVEN, on the real registry with a REAL Agent owner:
    - Disposing the exact live owner calls the producer's `cancel` with
      reason `owner disposed`, moves the record to `stopping`, and the
      disposal AWAITS the producer rather than completing immediately.
    - `stopping` is not terminal and still occupies the owner's bucket
      (packages/jobs/jobs-local/src/index.ts:322-326 counts `running` OR
      `stopping`), so a stopping job still blocks a replacement. That is the
      same rule this project's own state machine encodes for
      `cancel_requested`.
    - Service teardown behaves the same way with reason
      `jobs service disposed` (jobs-local/src/index.ts:481-487).
    - The owner had to be a real registered Agent: `ensureOwnerCleanup`
      validates exact instance identity (jobs-local/src/index.ts:448-455) and
      rejects a hand-made stub. That check is why a stale reference cannot
      stop somebody else's work.

  WHY THE TESTS HAD TO SETTLE THEIR PRODUCERS: teardown cancels live jobs and
  awaits their `done`. A test leaving one unsettled hung the cleanup hook
  (measured: 60s hook timeout, twice, on the first run). That is a small
  incidental proof of the contract, and it is recorded because it is the kind
  of thing that looks like a flaky test and is not.

NOT COVERED, AND SAID PLAINLY: no test here drives a background Job through
this project's OWN product path, because there is no such path. If this
project ever publishes a Job, layer (a) needs re-testing at the producer
boundary — the registry's guarantees do not cover the caller's own gating.


--------------------------------------------------------------------------
F06 — turn-stopping cancellation
--------------------------------------------------------------------------

THE SHAPE, VERIFIED RATHER THAN ASSUMED

  packages/core/agent/src/runtime-types.ts:381, `@mode serial`:

    'agent/turn-stopping'(this: Scoped<Agent>, payload:
      { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void

  Serial means no `next`. That is asserted at COMPILE TIME by
  `Parameters<Events['agent/turn-stopping']>['length'] extends 1`, so adding a
  `next` parameter fails the build. This was mutation-tested: a two-argument
  signature produces `Type 'true' is not assignable to type 'never'`.
  The payload shape is pinned by an assignability check, also mutation-tested
  (dropping `signal` gives TS2741).

  It is asserted at RUNTIME too, with the waterfall contrast measured on the
  same turn: a serial listener receives 1 argument, an `agent/pre-step`
  waterfall listener receives 2. Observed order on a real turn:

    pre-step:2, stopping-start:1, |gate-still-closed|, stopping-end, stopping-second:1

  The second serial listener had not run while the first was parked, and the
  turn could not close until the first settled. That is serial dispatch.

ABORT INSIDE THE LISTENER -> CLEAN ABORT, NOT A NEW CORRECTION ROUND

  A listener that calls `agent.cancel({kind:'user'})` on the real turn signal
  produces exactly one `turn/end` with reason `{kind:'aborted', reason:{kind:'user'}}`
  and exactly ONE model request. No correction round was opened to compensate.
  The agent ends genuinely idle with an empty inbox.

  A listener that THROWS produces exactly one `turn/end` with
  `{kind:'error', error:{message:'hook blew up', code:'UNKNOWN'}}`, an
  `agent/error` notification, and again ONE model request. The oracle's
  "明确错误" arm, satisfied.

  The loop re-checks the signal immediately after the serial dispatch
  (`signal.throwIfAborted()`, packages/core/agent-loop/src/agent.ts:318), which
  is why the in-listener cancel lands as an abort rather than being absorbed.

THE DEADLOCK, PROVEN AND DOCUMENTED

  INV-L4: this project must never await the same Agent's `whenIdle`/`dispose`
  from inside its own turn-stopping hook. The test proves the deadlock rather
  than describing it, then proves the source explains it:

    agent.ts:211-216  whenIdle() loops until `this.activityDone` stops changing
    agent.ts:198-208  `activityDone` is the driver promise, resolved only by
                      `kick()` returning
    agent.ts:228      kick() is `while (await this.turn()) {}`
    agent.ts:317      turn() awaits the serial `agent/turn-stopping` dispatch

  So awaiting whenIdle() inside the listener waits for the driver that is
  waiting for the listener. Measured: the hook enters, the agent stays
  `running`, and NO `turn/end` is ever appended — the turn has not even reached
  its boundary. Cancelling is the only way out, and it is also what makes
  teardown possible at all.

  The event's own documentation states the rule
  (runtime-types.ts:252-254): "listeners must not await agent.whenIdle() or
  their own owner's disposal."

THIS PROJECT REGISTERS NO SUCH HOOK — ASSERTED SO A FUTURE ADDITION FAILS

  The test scans the project's OWN files (resolved from the test's location,
  so it cannot pass by looking elsewhere): every non-test `src/*.ts`, the
  package's cordis.patch.yml, and both profile manifests and patches. Zero
  occurrences of `turn-stopping`. It also asserts neither profile names a
  `dsh-hooks` bridge, which would register listeners this project did not
  write. Mutation-tested: appending the string to src/host.ts fails the test
  with `expected [ Array(1) ] to deeply equal []`.

A FINDING THIS GATE MUST NOT HIDE

  "This project registers no turn-stopping hook" is TRUE. It is NOT the same
  as "nothing listens to this event in the daily profile", and the difference
  is recorded as its own test.

  The daily-candidate profile composes `dsh-base` + `dsh-web-app`
  (profiles/daily-candidate/package.json), and the web-app bundle mounts a
  stock consumer (packages/bundle/web-app/cordis.patch.yml:300-301):

    - id: workspace-changes
      name: '@deepseek-ai/dsh-workspace-changes'

  which registers a real listener
  (packages/deliverables/workspace-changes/src/index.ts:153-155):

    ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      await recorders.get(agent.session)?.stopping(turn)
    })

  This is a STOCK component this project deliberately did not remove (see the
  "NOT changed here, on purpose" section of the profile patch), so it is not a
  violation. But it means F06's stimulus is not hypothetical: a real listener
  runs at the turn's stop boundary in the daily profile, and it does real work
  there (a git working-tree snapshot, via recorder.stopping). That is exactly
  why the abort semantics above matter — a hook parked at that boundary is
  inside the serial chain, and the turn cannot close behind it.

  The test asserts the one thing that WOULD be a violation: the stock listener
  does not await its own agent's `whenIdle()` or `dispose()` inside the
  handler. Checked on the LISTENER BODY, not the whole file — the file does
  contain `dispose()` in `forget()` (line 108), so a whole-file search would
  be a false positive. Mutation-tested: inserting `await agent.whenIdle()` into
  that listener fails the test.

  The DSH source was restored byte-for-byte after that mutation and verified
  content-identical to HEAD (only pre-existing CRLF differences remain).

WHAT F06 DOES NOT CLAIM

  No measurement yet shows this project NEEDS its own turn-stopping hook. The
  plan says to add one only when measurement does; there is no such
  measurement, so "no hook" remains the correct state and the gate is closed
  on the contract plus the absence, not on a hook this project wrote.


--------------------------------------------------------------------------
WHY THE PASSES ARE TRUSTWORTHY
--------------------------------------------------------------------------

Four mutations were run against the finished test file, each in the code the
test claims to guard. All four were caught, and the mutated sources were
restored and hash-verified afterwards:

  1. src/host.ts — removed `if (signal.aborted) break`
     -> B09(a) fails: "expected [ { taskId: 'task-0', ... } ] to deeply equal []"
  2. src/host.ts — `port.launch(request, new AbortController().signal)`
     -> B09(b) identity test fails on Object.is
  3. a payload type with the `signal` field removed
     -> TS2741, at compile time
  4. a two-argument (waterfall-shaped) turn-stopping signature
     -> TS2322 "Type 'true' is not assignable to type 'never'"

  A fifth mutation targeted the stock listener (adding `await agent.whenIdle()`
  to workspace-changes) and was caught by the INV-L4 body check.

  Two of these are compile-time, which is why tsc.txt records a SECOND check
  against the test file itself. tsconfig.json excludes `src/**/*.test.ts`, so
  the project's own `tsc -p tsconfig.json --noEmit` never looks at a test file.
  That second check already earned its place: it caught a real error in the
  first draft of this test (an `agent/pre-step` listener typed as
  `(...args: unknown[])` whose return type did not satisfy `PreStepDecision`).

WHAT IS STILL OPEN

  - B09 is PASS for the layers that exist and for the real registry's
    documented contract, but NOT for "this project publishes a background Job
    and handles its signals correctly", because it publishes none. A future
    producer must re-test layer (a) at its own gating boundary.
  - F06 is PASS on shape, abort, error, the deadlock, and the absence of a
    project hook. It does NOT claim a need-driven hook design, because no
    measurement justifies one yet.
  - Neither gate was exercised against a live paid provider. That remains
    BLOCKED_EXTERNAL (no authorized budget), unchanged by this work.
