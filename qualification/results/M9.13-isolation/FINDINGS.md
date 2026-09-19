# M9.13 — isolation and lifecycle gates C12-C18

Runner: `packages/dsh-daily-work/src/isolation.test.ts`
sha256: `03db45deea31e0f90ac30f633e49c0068a41055806063a6cf2cc3c262528d258`
Result: **38 passed / 38**, `vitest run` exit 0. Typecheck exit 0 for both the
package and (separately) the test file, which the package tsconfig excludes.

Rig: one real `Context`, real `AgentLoop`, real `SubagentRuntime`, the real
in-process `spawn` and `fork` providers, real JSONL session persistence, real
storage domain, real `sessionQuery`. The model adapter is a scripted provider
boundary that holds every call on one gate — that is what makes "the root is idle
while children still run" a fact rather than a race, and it is not a second model
loop.

---

## THE QUESTION THIS FILE EXISTS TO ANSWER

The plan's finding about a community project is a NEGATIVE result: an
allowed-child-tools check that reads a CALLER-SUPPLIED filter and returns
`undefined` when no filter is passed is **not** a deployment-enforced allowlist.

Transposed to DSH: does the nesting limit come from deployment state, or from
`spec.request`? The answer is **two different things**, and conflating them is
how a deployment ends up claiming a limit it does not have.

**1. DSH's `maxDepth` is a CALLER-supplied cap, and an omitted one is not a
refusal.** MEASURED, not assumed
(`packages/subagent/subagent/src/child-agent.ts:50-59`):

    const childDepth = delegationDepthOf(parent) + 1
    if (maxDepth !== undefined && childDepth > maxDepth) throw new SubagentDepthError(...)

`delegationDepthOf(parent)` reads the PARENT'S persisted header
(`depth.ts:28-36`: `Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)`),
so the depth is a property of the parent and a caller cannot lower it. But the
cap is only an upper bound, and `maxDepth: undefined` **skips the comparison
entirely**. Asserted directly, both ways:

    child with header delegationDepth 1, request maxDepth 1   -> refused: "depth 2 exceeds maxDepth 1"
    child with header delegationDepth 1, request maxDepth 99  -> ADMITTED, child stamped depth 2
    child with header delegationDepth 1, request maxDepth omitted -> ADMITTED, child stamped depth 2

This is the community defect's exact shape, one field over: **the omission is
read as permission.** Any deployment that relies on "the caller will pass a cap"
has no cap.

**2. This project's deployment limit is a SECOND, independent gate.** It is
written into every `RunRecord` at creation from host config
(`maxDepth: this.config.maxDepth`) and never from a request, and the model's
`work` tool exposes no parameter that reaches it (`action`, `taskId`, `goal`,
`childId` — asserted as an exact set in `security.test.ts`). The launch port
hard-codes `maxDepth: deps.maxDepth` (`launch-port.ts`), so the omission path is
**unreachable from this project**: our port cannot express "no cap".

That is the whole difference, and C12 is closed on it: DSH supplies the depth
accounting, and this project supplies the deployment policy that DSH's per-request
field cannot.

---

## C12 — NESTING BYPASS: CLOSED, with one honest scope limit

Five paths that could add a child were each exercised. Every one is either
accounted for or explicitly refused, and the account is stated per path because
they are NOT all the same.

| path | what actually happens | accounted or refused |
|---|---|---|
| native `spawn` continuable | depth from parent header; cap 1 refuses grandchild | REFUSED |
| native `spawn` one-shot | same `resolveChildDepth` via the shared driver | REFUSED |
| `fork` one-shot | same shared driver, same refusal | REFUSED |
| workflow/PTC `agent()` | calls the ordinary one-shot seam with **no cap** | ACCOUNTED (see below) |
| external CLI (ACP) | advertises no capabilities; service refuses before the provider runs | REFUSED |

**The workflow/PTC row is the honest limit.** `workflow-ptc/src/host.ts:200` calls
`this.subagents.start(this.provider, { ... })` with no `maxDepth` at all. Because
an omitted cap is not a refusal (fact 1 above), a workflow run started from a
depth-1 child **does** create a depth-2 child. Asserted rather than glossed:

    workflow-shaped call (no maxDepth) from a depth-1 child -> ADMITTED, depth 2
    the same call WITH the deployment cap                   -> refused, "depth 2 exceeds maxDepth 1"

So the workflow path cannot *lift* anything — it sends no cap, so it inherits the
parent's depth — and the enforcement point for this project remains our own
recorded deployment cap. What is **NOT** closed is a deployment that mounts
`workflow-ptc` and relies on `maxDepth` alone to bound grandchildren: on this
source, that deployment has no grandchild bound. The profile patch's comment
("`maxDepth: 1` ... forbids them from opening unbilled grandchildren") is true
for children this project launches and is **not** true for children a workflow
launches. That is a finding, not a test failure, and it is recorded here rather
than papered over.

**The model-supplied `toolFilter` cannot lift anything**, asserted two ways:

- A `deny` filter removes tools and can never add them back, because restrictions
  INTERSECT (`core/tools/src/index.ts:1175-1181`:
  `if (layers.every(layer => layer.admits(name))) visible.set(name, definition)`).
  `every` requires ALL layers to admit, so a caller layer is monotone-shrinking.
  Measured: a child with `deny: ['canary_tool']` loses it; a child with no filter
  keeps it; the root keeps it either way (a per-child restriction is owned by the
  child's scope, `child-agent.ts:220-222`).
- A filter naming an unknown tool **throws** (`names unknown global tool ...`)
  rather than silently degrading to "no restriction" — which is the second half of
  the community defect.

**The shipped delegation tool cannot express a filter at all.** Its parameters,
read off the live registry, are exactly `description`, `prompt`,
`run_in_background`. `maxDepth`, `toolFilter` and `persona` come from PLUGIN
CONFIG (`tool-subagent/src/index.ts:84-110`), never from tool arguments.

**External CLIs are refused, not accepted-then-ignored.** ACP advertises
`depthLimit: false` / `toolFilter: false` and no `prepareContinuable`, and the
service rejects a request needing either capability BEFORE the provider runs
(`out-of-process.ts:51-63`, `index.ts:675-690`). Asserted on the live capability
table and the refusal contract.

**Not asserted, and why:** no foreign agent binary was actually spawned. The
refusal happens before the provider runs, so the provider's presence is the whole
input to it. Spawning a real ACP child would test the ACP wire, which is a
different gate.

---

## C13 — DEPTH AND FAMILY SCOPE: CLOSED

Three scopes that must not be confused, each measured separately.

**The pool is per-ROOT, not global.** `materialize` takes
(`continuation-activation.ts:486-489`):

    const pool = this.resident.get(inputs.parent.id)?.pool ?? this.rootPool(inputs.parent)
    const releaseSlot = pool.reserve(this.maxActiveSubagents())

and `rootPool` is a `WeakMap<Agent, ActivationPool>` keyed on the exact root
(line 180). Measured with the setting at 2: root A holds 2 and refuses a third
(`active child limit: 2`), while root B concurrently holds its own 2 and also
refuses its third. So `maxActiveSubagents` is neither a process-wide ceiling
(would be too permissive) nor a per-agent one (would be too restrictive) — it is
per family, and a descendant inherits its resident parent's pool, which is why
"family" is the accurate word.

**Per-run limits are a third scope.** Two runs on one host keep separate targets
(2 vs 5), separate reservations, and separate pause state: pausing run A leaves
run B admitting against its own target. Budgets do not cross-charge.

**One composition constraint, stated rather than hidden:** the launch port
carries ONE `deps.parent`, so a two-run test needs two ports. Using one port for
both runs attributes every child to one root and the child ids then collide in
the DSH registry. That is a real host-global constraint of the port, not a test
artifact, and it is why the two-run tests swap the port.

---

## C14 — GOAL CONFLICT: CLOSED

`disarm` is the mildest resolution and is not deletion in disguise
(`goal/src/index.ts:282-294`):

    "Remove process-local continuation authority without changing durable goal
     phase or revision. Lifecycle owners use this before unloading a driver; a
     later human-authorized resume records the new activation edge."

It calls `setActivation`, which writes ONE field on a `WeakMap` keyed by the
Session (line 496-499) and appends NO `goal/change` event. Measured after a
handover: objective unchanged, revision unchanged, **phase still `active`**, only
`activation` moved to `disarmed`. A later `resume` still works and advances the
revision, which is the recorded authorization edge.

**No double-continuation loop, measured on model calls.** With the real
`goal-round-driver` mounted and a 200-round cap, the driver queues rounds while
armed; after `takeContinuation` the request count is **frozen** across a 600 ms
window. The driver's own gate is
`if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return`
(`goal-round-driver/src/index.ts:165`), so a disarmed goal stops it at its next
decision point.

**A stale revision is rejected** (`goal/src/index.ts:455-467`): after an `edit`
advances the revision, `resume` with the OLD ref throws
`stale goal ref ...; current is ...`, and the current ref is accepted. That is
the compare-and-set a model cannot skip.

**Other Sessions are untouched.** Another root's goal stays `armed` with its own
objective and revision, because `disarm` is called with the run's own root Agent
and a different Session is a different WeakMap entry.

**Not exercised, and stated:** the model-facing `update_goal` TOOL was not driven
end to end. It requires an open model turn on a root Agent plus either a direct
human `user/message` source or an exact admitted goal round
(`tool-goal/src/authority.ts`, `goalToolExecution` / `requireDirectHuman`), which
needs the full agent loop driving a scripted tool call. What IS asserted is the
service-level compare-and-set the tool delegates to, which is where the rejection
actually happens.

---

## C15 — NOTIFICATION COALESCING: CLOSED

**Bounded.** `drain` keeps ONE in-flight drain per run and absorbs later requests
into it. Measured: four concurrent drains over one free slot produce exactly ONE
accepted launch and ONE real child.

**Lossless.** In a single 12-task drain every taskId survives with its own
`childId`, `attempt`, `state`, `assignmentDigest` and outbox entry — 12 of each.
Bounded did not mean lossy.

**Refusals are per-request, not per-batch.** A batch of `cheap` + `huge` admits
the first and refuses the second with reason `budget_blocked`, computed by the
same predicate the gate uses (`admissionReason(record, counts, request.reservedCost)`),
so the reported reason cannot disagree with what the gate did.

**Two questions kept apart, deliberately.** The drain's per-request reason knows
this request's cost; the run-level `counts().deficitReason` is REQUEST-AGNOSTIC
(it passes an outstanding cost of 0) and answers "is this run short of capacity in
general". In the same state those two give `budget_blocked` and
`slots_held_by_unconfirmed` respectively, and the test asserts BOTH, plus the
read-only `admissionCheck(runId, cost)` companion, so the distinction is pinned
rather than incidental.

**No empty turn burn.** The work service has no timer anywhere. Measured: with a
run open and nothing happening, the root's model-request count does not move over
600 ms and the root stays `idle`.

---

## C16 — IDLE vs COMPLETE: CLOSED, including the trap

`whenIdle()`'s own contract
(`core/agent/src/runtime-types.ts:182-188`):

    "Resolve after the current whole-agent activity reaches quiescence. This
     follows replacement work started before the observed driver retires, but
     does not identify the settlement of any particular message."

It is a statement about the DRIVER and says nothing about whether the work
succeeded. Asserted as a distinction, not a slogan: with two children held inside
their model call, `whenIdle()` resolves and the root is `idle` **while**
`confirmed === 0`, `activeAssignments === 0`, the run is still `open`, and both
children are still resident. A controller that read idle as completion would have
drained two live children.

**No early termination.** After the root goes idle, a further task is still
admitted — the observable meaning of "the run was not terminated".

**A later result IS observable in a native model step.** The registry delivers a
settlement notice to the durable parent
(`continuation-activation.ts:870-888`):

    const message = createSettlementMessage(activation.childId, terminal)
    this.sendWaking(parent, message, parent.status === 'idle' ? 'queue' : 'steer')

which falls through to `parent.followup(message)` for a non-resident parent
(lines 334-346) — a queued follow-up WAKES an idle root. Measured: after the child
settles, the root's request count advances and its own durable log contains a
`user/message` with `source.kind === 'subagent-settled'` naming the child. That is
the result-ref path, and it is why this project needs no polling.

**Admission is not execution, in the count.** Ten admitted children report
`durablyAdmitted === 10` and `activeAssignments === 0`. Observing a task is not
enough either: the count moves only after the explicit `executing` transition, so
`accepted` can never be an active worker.

---

## C17 — RECOVERY AFTER A FAILED FINISH: CLOSED

`beginClosing` is a REQUEST, not a confirmation. It moves the run to `closing`
and stops new admissions (`reason: 'run_not_open'`), and it does NOT drain. The
distinction is load-bearing because the real contract says so
(`subagent/src/index.ts:337-345`):

    "Close continuable admission below exact live parent Agents ... The scoped
     cutoff lasts until each exact parent leaves the registry."

**The permanent drain has NOT been called**, asserted against the real seam: after
`beginClosing`, a correction child is still established, runs, and settles. Only
AFTER the explicit `drainContinuableDescendants` does the same parent refuse with
`draining; the operation was not admitted` — so the pre-drain success is the
observable proof that the drain had not happened.

**A closed run is not revived by `resume`.** `resume` only lifts `paused`
(`phase === 'paused' ? 'open' : phase`), so `closing` stays closed through it,
while a `paused` run genuinely resumes. The pause also leaves a durable outbox
entry, so it is observable in the record and not only in memory.

**A failed launch holds its slot.** The task goes to `unknown` with the
uncertainty recorded, `reserved` stays 1, and the deficit is unchanged — freeing
it would admit a correction alongside a child that may still exist.

---

## C18 — FINAL DRAIN: CLOSED

**Explicit refusal, naming the parent.** After
`drainContinuableDescendants([root])`, `startContinuable` throws a
`SubagentError` with code `DRAINING` whose message contains the parent's session
id (`assertAdmitting`, `continuation-activation.ts:446-458`), and no Agent was
created.

**No private flag revives it.** The scoped cutoff is a `Map` keyed on the EXACT
root Agent, and its own doc comment says entries remain "until that exact root
leaves the Agent registry" (lines 187-193), deleted only on `agent/disposed`
(217-219). Asserted by repetition: a second drain plus three further attempts all
refuse, and none created an Agent.

**The close is scoped, not global.** An unrelated root admits normally after
another root is drained.

**Subsequent work goes through a NEW run.** The closed run stays `closing` through
a `resume`; new work is a new `RunRecord` with its own authorization ref, epoch 1,
empty tasks and `open` phase; both records coexist; and the new run admits while
the old one is still refused.

---

## HONEST GAPS

1. **Workflow-launched grandchildren are not bounded by `maxDepth`.** Detailed
   under C12. The path omits the cap, and an omitted cap is not a refusal on this
   source. Our own launches are bounded; a workflow's are not.

2. **The `update_goal` tool is not driven end to end** (C14). The service-level
   compare-and-set it delegates to IS asserted; the tool's turn/authority gating
   is not.

3. **No external agent binary was spawned** (C12). The out-of-process refusal
   happens before the provider runs, so the capability table and the refusal
   contract are the whole input to it.

4. **`toolFilter` is asserted at the seam, not through the shipped tool.**
   `tool-subagent` reads its filter from plugin config, and the assertion here is
   that the TOOL cannot pass one — the config path itself is exercised by DSH's
   own tests, not by this file.

5. **The launch port carries one parent.** A host serving two runs needs a port
   per root; this is a real constraint of `ContinuableLaunchDeps`, stated here
   because a two-run test that ignored it would measure the port rather than the
   run.

---

## Reproducing

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
npx vitest run src/isolation.test.ts --maxWorkers=1 --no-file-parallelism
```

38 tests, all passing. `tsc.txt` records both the package-wide typecheck and an
explicit typecheck of the test file — the package `tsconfig.json` excludes
`src/**/*.test.ts`, so the test file is NOT covered by the package-wide run, and
the evidence states that rather than implying coverage.

`source-digests.txt` names the exact revision of every DSH source quoted above
and of this project's own sources, because a claim quoted from a file is only
checkable against a named revision.
