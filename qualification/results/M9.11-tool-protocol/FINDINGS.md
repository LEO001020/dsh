# M9.11 — tool-protocol gates B04–B08

**Status: all five gates CLOSED (PASS), with three honest limits recorded below.**

Evidence in this directory:

| file | what it is |
| --- | --- |
| `tests.txt` | real `vitest run src/tool-protocol.test.ts` output, 22 passed / 0 failed, `VITEST_EXIT=0` |
| `tsc.txt` | `tsc --noEmit` twice: production sources (`tsc_exit=0`) and all of `src/**` including tests (`tsc_exit_all_sources=0`) |
| `source-digests.txt` | sha256 of every local file and every DSH file the contract quotes come from, plus the DSH commit and toolchain versions |
| `FINDINGS.md` | this file |

Run the gate yourself:

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/tool-protocol.test.ts --maxWorkers=1
```

---

## What the tool pipeline actually does

Read from `packages/core/tools/src/index.ts` and confirmed by running it, not summarised from documentation.

`ToolRuntime.execute` is one ordered pipeline. The order is load-bearing and each stage has a different power:

1. **materialize arguments** — `snapshotJsonValue` then `deepFreeze`. A non-lossless argument set fails the call before any policy sees it.
2. **mode collapse** — under `ptc`, a model-direct call naming anything but `run_code` is denied `UNKNOWN_TOOL` *before* the policy pipeline. This is deliberate: pre-execute listeners, approval `ask`, and guards must never observe, let alone approve, a call that can only fail.
3. **`tools/pre-execute` waterfall** — extensible. It CAN return `{ kind: 'allow' }`, and a later listener can overwrite an earlier one's `deny`. This stage is therefore **not** a security boundary.
4. **`ask` resolution** — an approval service returning `allowed-once` proceeds; an absent service, an absent agent, or `unavailable` all degrade to `deny`.
5. **guards** — `ToolRuntime.guard`. Monotonic, synchronous, and it runs **after** the whole waterfall. The source says why: *"Because guards have no allow result, listener ordering cannot turn a denial back into permission."* The decision is `decision.kind === 'allow' ? this.guardReason(exec) : decision.reason`, so a guard is consulted **only** when the waterfall allowed.
6. **`tools/execute` waterfall → body** — the around-dispatch seam.
7. **canonical-value boundary** — `createSuccessResult` snapshots the returned value, validates it against `output.schema`, deep-freezes it, and only then calls `output.render`. A `post-execute` listener that replaces the value goes through the same boundary, which is why a listener cannot widen the value past the declared schema.
8. **`tools/post-execute` waterfall** — accept / replace / block.
9. **`tools/result` observers** — emit-only, failure-contained, and they run **last**, on a frozen snapshot.

Two consequences that B06 and B08 turn on:

- **The canonical value and the model text are different fields.** `ToolExecutionSuccess.value` is the JSON authority; `content` is `ContentBlock[]` produced by a pure `render` projection. A caller never has to parse prose to learn an id.
- **The observation is not the record.** `tools/result` fires after the outcome is already materialized, so an observation failure cannot change what happened — only what was observed. Containment is real (`notifyResult` catches both sync throws and rejections and logs `tools/result observer failed: …`), and the log line is asserted so containment is not confused with silence.

---

## B04 — exact owner

**Gate:** the same `SessionId` is resumed as a NEW Agent instance; the OLD callback tries to update state. The old object/epoch must be refused and must not pollute the new run.

**Result: PASS**, via a new file `src/tool-protocol-guards.ts`.

### The measured hazard

`AgentRegistry.resume` publishes a **new Agent object under the same id**. Measured, not assumed:

```
new !== old: true
registry.get === new: true,  registry.get === old: false
String(old.id) === String(new.id): true
```

But `findRunFor` in `src/tools.ts` resolves a run by string:

```ts
const sessionId = agent.session.header.id
for (const runId of service.listRunIds()) {
  const record = service.getRun(runId)
  if (record?.rootSessionId === sessionId) return runId
}
```

So a superseded Agent object maps to the run the NEW lifecycle owns. This is asserted as a failing-then-passing pair: `the guard is load-bearing: without it the stale object IS accepted` shows the stale object reaching `finish` and moving the run to `closing`; with the guard mounted the same call is refused and the record is byte-identical afterwards.

### The discipline mirrored, quoted from the real sources

`packages/terminal/terminal/src/index.ts`:

```ts
private isLiveOwner(owner: Agent): boolean {
  return !this.disposedOwners.has(owner) && this.ctx.get('agents')?.get(owner.id) === owner
}

private ensureOwnerCleanup(owner: Agent): void {
  if (!this.isLiveOwner(owner)) {
    throw new TerminalError(`agent "${owner.id}" is not the registered PTY owner`, 'OWNER_NOT_LIVE')
  }
  ...
```

`packages/jobs/jobs-local/src/index.ts`:

```ts
if (agents.get(ownerId) !== owner) {
  throw new Error(`agent "${ownerId}" is not the registered agent instance (background job owner must be live)`)
}
```

Both compare **object identity** against the registry. The real agent-registry API (`packages/core/agent/src/index.ts`) is:

```ts
/** Look up a live agent. */
get(id: SessionId): Agent | undefined { return this.store.get(id)?.agent }
```

and `enter()` is the collision boundary: `if (this.store.has(id)) throw new Error(\`agent "${id}" is already registered\`)` — which is *why* a resume must be a different object.

### Why a guard and not a check in the tool body

A permission expressed in `tools/pre-execute` is not monotonic: stage 3 above can overwrite a `deny` with an `allow`. `ToolRuntime.guard` is the monotonic slot. `src/tool-protocol-guards.ts` registers through it.

### The epoch: NOT enforceable, and reported as such

`record.ts` documents `epoch` as *"Monotonic run epoch. Bumped when a run is re-adopted by a new host generation. A callback carrying a stale epoch must be rejected rather than allowed to write authoritative state."*

**No code reads or writes it.** `initialRunRecord` sets `1`; nothing bumps it, and no call site accepts an epoch to compare against. An assertion that "a stale epoch is refused" would be testing a field that cannot be presented to any API. What the test asserts instead is the truth: the field exists, stays at `1` across the resume, and is not the enforcement point.

**This is a real gap, not a closed gate.** Object identity covers the resume case that B04 names. It does **not** cover a run re-adopted across a process boundary, where there is no shared object to compare — that case has no enforcement today. Recorded in the "Left open" section.

### Evidence for B04

| test | what it establishes |
| --- | --- |
| `a resume publishes a DIFFERENT object under the SAME id` | the premise; would make the rest vacuous if false |
| `refuses a stale owner at the guard, and the live owner still works` | the gate; refusal + byte-identical record + live owner unaffected |
| `the guard is load-bearing: without it the stale object IS accepted` | keeps the guard from being removed as redundant |
| `the registry identity test is the discipline the terminal and jobs services use` | the predicate fails closed with no registry, leaves other tools alone, and defers an agentless call to the body's more specific error |
| `the run epoch is inert` | the honest limit above |

---

## B05 — standing scope

**Gate:** two roots on the SAME preset, interleaved calls to `work`. Each run's tasks / budget / cancellation must be fully isolated.

**Result: PASS.**

### The trap, measured

`packages/preset/agent-presets/src/index.ts`:

> *"each session composes its model-facing plugin set from one preset `cordis.yml`, mounted ONCE per preset under a standing scope and joined by every agent that names it. The standing mount is what makes a preset one composition rather than one per session: its plugin instances, tool registrations, prompt sections, and projection units exist exactly once…"*

Measured in the rig: `livePresetMounts()` has length **1**, `standingMountFor(a.ctx) === standingMountFor(b.ctx)`, and `ctx.tools.get('work', a) === ctx.tools.get('work', b)` — **the same `ToolDefinition` object** for two Sessions. So the `apply(ctx)` closure in `tools.ts` ran exactly once, and any mutable per-agent field in that closure would be shared. `tools.ts` holds none, and its header says so: *"A `currentRun` field here would be a cross-session contamination bug, because a preset's composition is standing, not per-session."*

The isolation test therefore exercises the closure with interleaving rather than asserting the comment:

- A and B get **different targets** (2 and 3) and **different ready counts** (5 and 9), so a leaked counter would show as a wrong number, not an ambiguous one.
- A submits `t1` → lands in A only (`run-b.tasks` is `{}`, `run-b.budget.reserved` is 0).
- B submits the **same** `taskId` `t1` → admitted in B, A's reservation unchanged at 1.
- `pause('run-a')` → A's next submit is refused with `reason: 'run_not_open'`; B's next submit is still accepted and `run-b.phase` stays `open`. This is the cancellation-isolation half.
- Final status reads show A `durablyAdmitted: 1` and B `durablyAdmitted: 3`, and the launch port recorded exactly the four launches.

A separate test reads in the **opposite order from the writes** (B acts, then A reads) to exclude a `currentRun`-style field: A must still resolve A after B acted.

A third test confirms a Session with no run is refused (`this session has no active run`) rather than handed another Session's run — the failure mode a "first run found" implementation would have.

### Evidence for B05

`tests.txt` → the four `B05` tests. `the preset is ONE standing mount, so the tool definition object is shared` is the premise assertion; `interleaved calls keep tasks, budget and cancellation per run` is the gate.

---

## B06 — canonical tool output

**Gate:** call the SAME tool through the native path and through PTC (`ctx.ptcRuntime`) and compare. The canonical JSON value must be identical — no prose parsing, no BigInt / circular value / unvalidated field.

**Result: PASS on the real PTC runtime.** `NodePtcRuntime` (the released TypeScript backend) is mounted with its real dependencies and spawns a real Node subprocess per program. No fake runtime was used, so the comparison is not a fake agreeing with itself.

`mode: 'both'` puts `work` and the reserved `run_code` transport in one registry, so both routes go through the same pipeline.

### Native vs PTC, measured

Native returns `value` = the work status object. PTC returns `run_code`'s own canonical shape `{ logs, result, sandbox? }`, where `result` is the completion value the program returned. The assertion is `expect(ptc.value.result).toEqual(native.value)` — **one canonical JSON value reached two ways**, and the program received the structure rather than rendered text.

The distinction the gate asks for is asserted directly rather than conflated:

- `content` is `ContentBlock[]`; `value` is JSON; they are different fields and different objects.
- `value` is deep-frozen (`Object.isFrozen(native.value) === true`).
- `JSON.parse(content[0].text)` equals `value` exactly, which is what makes the text a **projection**: nothing in it is absent from the value. The model can read it; a program gets the structure.
- `run_code`'s own output schema is also `additionalProperties: false`, so the wrapper cannot smuggle a field past the caller either.

### Refusals, measured against the real boundary

`snapshotToolValue` → `snapshotJsonValue` returns `undefined` for a lossy value and becomes `ToolOutputError` with `code: 'INVALID_TOOL_OUTPUT'`. Confirmed for `bigint`, a circular object, an `undefined` property, and a function property. An undeclared field is refused with `"value.smuggled" is not a declared property (additionalProperties: false)`, and the test drives this through the **real work tool** with a hostile `tools/post-execute` listener that tries to widen the value — the declared schema refuses it after the listener ran.

### The model-facing schema is closed

`work`'s `output.schema` has `type: 'object'`, `additionalProperties: false`, and every count declared individually. There is no merged "workers" number that could hide a disagreement, which is the counting module's premise.

### Evidence for B06

`tests.txt` → the five `B06` tests. The two PTC round-trips each cost ~200 ms of real subprocess startup.

---

## B07 — synchronous guard

**Gate:** a later `pre-execute` listener tries to turn a `deny` into an `allow`. The final guard must still deny, and an `async` function returning a Promise must NOT be accepted as a guard return value.

**Result: PASS.** No `Decision` type was invented; the contract is quoted from the source.

`packages/core/tools/src/index.ts`:

```ts
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

and the stage itself:

```ts
const denialReason = decision.kind === 'allow' ? this.guardReason(exec) : decision.reason
```

`PreToolDecision` is `allow | deny | cancel | ask` — there is no `deny`-overriding member, so the "later listener turns deny into allow" attack has no vocabulary to express itself in *within the guard stage*. The attack is expressed in the **waterfall**, which is where it can succeed — and then the guard still wins because it runs after.

### Measured

- A guard denies; then an allowing listener is registered **after** it; then another with `{ prepend: true }` so it runs **before** every other listener; then a counting listener proves the waterfall really ran and really returned `allow`. The call is still denied with the guard's reason, the body never runs, and the run record is byte-identical.
- A guard whose resolved value would mean "allow" (`async () => undefined`) is **not** awaited. The Promise is not `undefined`, so `guardReason` treats it as a denial reason; the Promise is also not JSON, so materialization fails. Either way the call does not succeed — fail-closed. The contrast is asserted in the same test: a **synchronous** guard returning `undefined` does allow.
- A **throwing** guard fails closed: `guardReason` calls the guard with no try/catch, so the throw propagates into `toolErrorResult`. A guard that threw its way to "allow" would be a way to disable the guard stage by breaking it.

### One protocol limit, found by asserting it

`the tool surface offers no parameter that widens its own authority` was first written asserting that an undeclared argument is rejected `INVALID_ARGS`. **That was wrong, and the test caught it.** DSH's implicit parameter root is an **open** object — `parameterSchemaSpecToJsonSchema` (`packages/core/tools/src/schema.ts`) builds `{ type: 'object', properties, required }` and never sets `additionalProperties`. Measured: `{ action: 'status', targetChildren: 999, budgetCeiling: 999_999 }` reaches the body with all fields intact and the call **succeeds**.

The test now asserts the truth: the widening argument is **inert** (the run's target stays 2 and the ceiling stays the configured value, because the handler reads configuration from the service and never from `args`), while a malformed **action** — the parameter that actually selects behaviour — is refused at the wire with `INVALID_ARGS`. The refusal is by absence of any code path from an argument to a configuration field, which is a property of the handler rather than of the wire.

---

## B08 — observation failure does not hide

**Gate:** make the `tools/result` observation writer fail. The code must NOT claim the execution was rolled back, and critical state must stay explicit through the project's own intent/reconcile path.

**Result: PASS.**

### The real event's containment semantics, quoted

`packages/core/tools/src/index.ts`:

```ts
/**
 * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
 * ...
 * @mode emit
 */
'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```

```ts
/** Notify observers without exposing a mutation or error channel into the outcome. */
private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
  Object.freeze(exec)
  const reportFailure = (error: unknown): void => {
    this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`)
  }
  const callbacks = this.ctx.events.dispatch('emit', [scopeTarget(this, exec.agent), 'tools/result', exec, result])
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(exec, result)
      void Promise.resolve(returned).catch(reportFailure)
    } catch (error: unknown) {
      reportFailure(error)
    }
  }
}
```

The return type is `undefined`: the event has **no channel into the outcome by construction**. Containment cuts both ways and both are asserted — the failure must not become the tool's outcome (which would tell the model its submit failed and invite a retry), and it must not be swallowed silently (which would hide a broken audit sink).

### Measured

- Two observers, one throwing synchronously and one rejecting asynchronously. The caller still receives the **tool's** outcome: `{ action: 'submit', accepted: true, taskState: 'accepted' }`, `isError: false`. The model text contains no `rollback` / `revert` / `undo` wording. The log carries `tools/result observer failed` naming the sink's own message.
- **Ordering is the property that makes containment safe.** A test asserts it from *inside* the observer: at the moment the observer runs, a real durable read through `service.getRun` already shows `budget.reserved === 1` and `tasks['t1'].state === 'accepted'`. If the observation were what recorded the admission, a failed observer would mean an admitted task with no record. It is not: the record is written before the observation, and it is unchanged afterwards.
- The reconcile path is used rather than a rollback claim. The task is read from the record and resolved by evidence; the `unknown` branch returns `releaseSlot: false` with a reason that says the outcome *"cannot be established from local evidence"*. Applying it holds the slot: `quarantinedUnknown` becomes 1 and `capacityDeficit` stays 1. No branch mentions a rollback.
- The mirror image: a failed observation on a **refused** admission does not turn the refusal into a success. `accepted: false` survives, and the record shows no task and no reservation — the double-spend direction.

### Evidence for B08

`tests.txt` → the four `B08` tests.

---

## Files

**Created (mine):**

- `packages/dsh-daily-work/src/tool-protocol.test.ts` — 22 tests, B04–B08
- `packages/dsh-daily-work/src/tool-protocol-guards.ts` — **a production change.** The exact-owner guard, plus `isExactLiveOwner` and `exactOwnerDenialReason` as exported predicates. This is a NEW file because I may not edit `tools.ts`, and because the guard belongs at the host plane where a deployment can decide whether to mount it. **To close B04 in production, a profile must mount this plugin. It is not mounted by `cordis.patch.yml` today.**
- `qualification/results/M9.11-tool-protocol/` — this directory

**New node_modules junctions created** (required by the new tests, per the project's junction convention):

```
node_modules/@deepseek-ai/dsh-ptc-runtime      -> packages/ptc-runtime/ptc-runtime
node_modules/@deepseek-ai/dsh-ptc-runtime-node -> packages/ptc-runtime/ptc-runtime-node
node_modules/@deepseek-ai/dsh-util-values      -> packages/util/values
node_modules/@deepseek-ai/dsh-fs               -> packages/fs/fs
node_modules/@deepseek-ai/dsh-fs-local         -> packages/fs/fs-local
```

**Not touched:** `src/host.ts`, `src/record.ts`, `src/counting.ts`, `src/tools.ts` (owned by another agent). Note that `host.ts` / `record.ts` / `counting.ts` were being edited concurrently during this work; `source-digests.txt` records the exact hashes the green run was produced against, and `tests.txt` was regenerated after the last observed change.

---

## Left open

These are real gaps. None of them is disguised as a pass.

1. **The run `epoch` is inert.** `record.ts` documents it as the enforcement point for a run re-adopted by a new host generation, but nothing bumps it and no API accepts one to compare. Object identity (B04) covers an in-process resume; a run re-adopted across a **process** boundary has no enforcement today. Closing this needs a call site that takes an epoch and compares it, which is a `host.ts` change and therefore not mine to make.
2. **The guard is not mounted by the shipped profile.** `src/tool-protocol-guards.ts` exists and is tested, but `cordis.patch.yml` does not include it. B04's production closure depends on a profile change owned by whoever owns the composition.
3. **DSH's implicit parameter root is open.** Undeclared tool arguments reach the body. The refusal for this project is by handler structure (configuration is never read from `args`), not by the wire. A future tool that read a configuration field from `args` would be silently widen-able.
4. **`quarantinedUnknown` is 0 before the reconciliation is applied.** In the B08 reconcile test the record is still `accepted` at the moment `reconcileTask` returns `unknown`; the count only becomes 1 after `transition`. That is correct — the decision is not the write — but it means a reader must not treat a reconcile *decision* as recorded state.
5. **B04's live-owner test uses `resume`, not a concurrent double-lifecycle race.** Two overlapping `resume` calls on one id are not exercised; the registry's own collision boundary (`enter()` rejects a duplicate id) is asserted by reading the source rather than by racing it.
