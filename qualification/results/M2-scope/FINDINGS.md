# M2 — the extracted public programmatic-call scope

**Status: BRG-01..08 all PASS, with one measured limitation stated below and one
gate closed by a comparison test rather than an identity claim.**

Evidence in this directory: `tests.txt` (42/42), `tsc.txt` (both configs exit 0),
`source-digests.txt`, `boot-probe.json` (a real `dsh --profile daily` boot).

## 1. The real `ptc.ts` structure, and what was actually extracted

Read at `D:/DSH/src/dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
(`ptc.ts` sha256 `7a7c19cf…`, `index.ts` sha256 `e040cf44…`).

| Location | What it is |
|---|---|
| `ptc.ts:326` | `createRunCodeTool(registry, options)` — the `run_code` definition; the whole scope lives inside its `execute` |
| `ptc.ts:540-620` | the nested dispatch: `const scheduler = registry[TOOL_RUNTIME_SCHEDULER]`, then `prepare` → `dispatch` → `finalize`/`finish` |
| `ptc.ts:405-407` | `runController` — a run-scoped `AbortController` that follows the outer signal in and fires when the run settles |
| `ptc.ts:425-514` | the driver lane: `PendingDispatch`, `pendingQueue`, `commitQueue`, `drive()`, one ordered lane |
| `ptc.ts:516-524` | `drainDispatches()` — awaits the lane, then `logWork` |
| `ptc.ts:632-654` | commit: `finalize`/`finish`, image deferral, `additionalContexts`, `concludesTurn`, `settle(result)` |
| `index.ts:798` | `readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler` — the private, `@internal` symbol |

**What is genuinely reusable, and what is not.** The scheduler symbol is private
and `@internal`; importing it from outside is forbidden by the task and by
ARCHITECTURE §3. But it does not need to be imported, because `ToolRuntime.execute`
is the registry's own composition of the *same four staged functions*:

```
index.ts:1349  execute() = prepareExecution(exec, prepared => completeScheduledExecution(prepared))
index.ts:1352  completeScheduledExecution switches on prepared.kind:
                 'dispatch'    -> dispatchScheduledExecution -> finalize/finishScheduledExecution
                 'post-result' -> finalizeScheduledExecution
                 'final-result' -> finishScheduledExecution
```

So `execute()` runs the identical `tools/pre-execute` waterfall, guard slot,
approval `ask` seam, output-schema validation, `tools/post-execute` waterfall,
`finalizeContent`, and `tools/result` notification that `ptc.ts` reaches through
the symbol. **The extraction is therefore a scheduling extraction, not a policy
extraction** — which is why no upstream patch was needed.

## 2. Upstream patching: NOT NEEDED, and none was made

`git status --porcelain -- packages/core/tools/` in the pinned checkout is empty;
`source-digests.txt` records it. There is no patch digest and no base-SHA-plus-patch
record, because there is no patch.

The public surface used: `registry.execute`, `registry.executionMode`,
`registry.schemas`, `registry.register`, `registry.guard`, `registry.restrict`,
`registry.get`, plus the exported `ToolExecutionToken` / `ToolExecutionInput` /
`ToolExecutionResult` / `RUN_CODE_NAME` / `TOOL_ABORTED` /
`TOOL_ABORTED_BEFORE_DISPATCH` types and constants.

**`parent` is host-bound and never fabricated.** `ToolExecutionToken` is a branded
symbol the registry owns; `ProgrammaticCallScopeOptions.parent` requires the caller
to pass the *enclosing transport execution's own* `exec.token`. The test file uses a
stand-in only for ownerless calls and says so in a comment at the point of use. The
service (`programmatic-scope-plugin.ts`) has no method that accepts an agent id, a
session id, or a policy override — the actor and policy are construction inputs.

## 3. The one real limitation, measured rather than claimed

`ptc.ts` splits each sub-dispatch *at the scheduler seam*, so its ordered
pre-execute stages run inside ONE driver lane: a slow pre-execute on call N delays
the START of call N+1. A scope built on `registry.execute` cannot reproduce that,
because each call is one indivisible `execute()`.

This is asserted in both directions rather than asserted away:
`MEASURES the scheduling difference from run_code instead of claiming identity`
observes `maxConcurrentPreExecute > 1` on the scope route.

It is a scheduling difference, not a policy bypass: every call still runs the
complete gate, `ToolGuard` is synchronous by signature (so ordering cannot change
its answer), an approval carries its own request id, and the registry documents
`tools/pre-execute` as receiving each call — not as being serialized against other
calls.

## 4. BRG gates

| Gate | Verdict | Evidence (test names in `programmatic-scope.test.ts`) |
|---|---|---|
| BRG-01 | **PASS** | `produces the SAME canonical value on all three routes` (native, `run_code`, scope → one identical value, tool ran 3×); `a monotonic GUARD denies the scope exactly as it denies a native call` (one denial reason observed 3×, body never ran); `an ask decision reaches the scope and a denial is not a bypass`; `a real ApprovalService denial reaches the scope as a denial` (audited on the session); `post-execute policy replaces the value`; `a canonical value violating the declared output schema fails`; `the scope does NOT bypass the ptc presentation collapse` |
| BRG-02 | **PASS** | `a tool unregistered while the scope is open fails its next call`; `names() is a LIVE read, and revocation is visible through it`; `a tool unregistered by its own disposer is gone from the next call` (and re-registration is picked up) |
| BRG-03 | **PASS** | `returns the declared T and is never an ArtifactRef` (type checked across 6 calls); `over-budget value delivery throws with the retained reference and does NOT re-execute` (`ScopeDeliveryBudgetError`, `executions === 1`) |
| BRG-04 | **PASS** | `runs the tool EXACTLY ONCE and returns a reference to the final value` (`echo.calls` length asserted, and re-read does not re-run); `the reference carries the POST-POLICY value, not the pre-policy one` |
| BRG-05 | **PASS** | `a post-policy BLOCK leaves no recoverable original in the store`; `a policy that REPLACES a sensitive value leaves only the replacement retrievable`; `a blocked call retains nothing even under reference delivery` — each sweeps every object in the store and asserts the secret is absent |
| BRG-06 | **PASS** | `MANY concurrent wrapped calls complete without exhausting the pool`; `re-entrancy: a nested call may itself open a nested call, many levels deep` (maxParallel 1); plus barrier/cap/overlap/cancel-drain tests |
| BRG-07 | **PASS** | `queued-unstarted calls are REFUSED with a recorded disposition`; `a host JOBS HANDOFF takes ownership`; `close resolves only AFTER in-flight work has settled`; `close is idempotent`; `invoking after close is refused`; `the host service closes every live scope on teardown` |
| BRG-08 | **PASS** | `a security additionalContext reaches the enclosing execution, bounded`; `concludeTurn is preserved from a nested success and NOT from a policy-blocked one`; `a BULK image does NOT automatically enter model context`; `the control and content slots are SEPARATE`; `past the direct bound, notices are COALESCED into one bounded record, not dropped` |
| stock `run_code` | **PASS — no regression** | five comparison tests: dispatch events and curated output byte-identical; `UNKNOWN_TOOL` collapse intact; `ABORTED_BEFORE_DISPATCH` intact; nested `concludeTurn` forwarded; nested image still deferred |

### BRG-06 is not vacuous — mutation evidence

The nested-admission branch was mutated to `if (false && nested)` (always queue
through the pool) and the suite re-run. Result: `re-entrancy` **timed out after
60 000 ms** — a real deadlock, the exact circular wait the gate names — and
`MANY concurrent wrapped calls` also failed. The mutation was reverted and the
suite returned to 42/42. So the gate fails when the property is removed, which is
what distinguishes a real test from a restatement.

## 5. Wired or it does not count

`docs/GAPS.md` G-FIX-04 records the lesson: a gate whose oracle is weaker than its
scenario passes while the product is broken. Three instances exist in this project
(`setLaunchPort` and `takeContinuation` with zero production callers; `dsh-ipython`
declaring no `dsh.bundle`). A scope mounted only by its own test would be the
fourth.

So the scope is exposed as a **host service from a loadable plugin entry**:

- `packages/dsh-daily-work/src/programmatic-scope-plugin.ts` exports `apply` (so a
  declarative loader row can mount it) and `ProgrammaticScopeService` on
  `ctx.programmaticScope`.
- `package.json` exports `./programmatic-scope`.
- `cordis.patch.yml` carries **DIFFERENCE 6**, row `daily-programmatic-scope`.

**Intended consumer: the M3 `python_exec` cell.** When the IPython kernel's
native-tool callback arrives, the cell handler asks the service for a scope bound
to the enclosing execution and routes every `tools.<name>(...)` call through it;
`observations.call` in ARCHITECTURE §5's Python SDK is the same call with
`delivery: 'reference'`. No model-facing tool is added — a second tool that could
call tools would be the "second tool-bridge engine" MASTER_EXECUTION_PLAN M2
forbids.

**Proof it loads, in a real profile boot** (`boot-probe.json`):

```json
{ "servicePresent": true,
  "interface": ["open:function","close:function","closeAll:function","openCount:function","store:object"],
  "registeredTool": true,
  "valueDelivery": "probe:value-route",
  "referenceDelivery": { "kind": "scope-reference", "bytes": 23, "recovers": true },
  "dispositions": [ {"name":"m2_scope_probe","disposition":"settled","nested":false}, … ],
  "errors": [], "openAfterClose": 0 }
```

with **zero** `did not activate` / `failed to import` warnings. The probe registers
its own tool into the live registry, opens a scope, exercises both deliveries,
closes, and reads the disposition accounting.

## 6. Things found by measurement, recorded rather than smoothed over

1. **`isJsonValue` is not a type predicate.** `ContentBlockMap` is merge-extensible
   and its members carry no index signature, so a block array is not *statically*
   assignable to `JsonValue`. The first version of this file cast it, and the
   coordinator correctly rejected that as an `as any`-class bypass. The fix asks
   the runtime's own gate (`isJsonValue`, which takes `unknown`) and stores a
   declared `RetainedPayloadEnvelope` whose `lossless` field states whether the
   bytes carry the whole payload or metadata only. No assertion remains.
2. **`ctx.tools` is refused without `inject`** — including on the *service's* own
   context, which is a different context from the plugin function's. Measured in
   the boot probe: the service mounted, listed its whole interface, then failed on
   the first `open()`. Fixed with `static readonly inject = ['tools']` on the class.
3. **A probe under `qualification/runners/` cannot use bare DSH specifiers.** Its
   first version imported `@deepseek-ai/dsh-tools` and the loader reported
   `failed to import` — a property of the probe, not the product, and it looked
   like a product defect until the warning was read carefully.
4. **`commit()` must not classify by the scope's `closed` flag.** An earlier
   version reported a call that had completed successfully during a drain as
   `cancelled`. The registry's own cancellation codes (`TOOL_ABORTED`,
   `TOOL_ABORTED_BEFORE_DISPATCH`) are the authority; a tool's own failure is a
   settled outcome with an error, not a cancellation.
5. **`abandon()` must settle the call's body promise.** The drain awaits it, so
   without that a refused call would hang the close forever.

## 7. Left open

- **The reference store is in-process and unbounded.** `createMemoryReferenceStore`
  is a seam, not the M4 artifact store: no quota, no GC, no durability, no
  authorization. M4 owns the real one. This is why `ScopeReference` is a declared
  shape with a `schemaVersion` rather than a bare string.
- **`handoffToJobs` is not yet bound to the real `ctx.jobs` registry.** The scope
  accepts a host handoff and records the job id (tested with a fake); nothing in
  the daily profile supplies the real `JobRegistry` yet. Until then a call still
  queued at close is *refused* with a recorded disposition, which is the safe
  branch, not a silent background run.
- **No real `python_exec` consumer exists yet** — that is M3. The service is
  loadable and proven loadable; the cell handler that calls it is M3's work.
- **The scheduling difference in §3** is a real behavioural difference from stock
  `run_code`. If M3 requires `run_code`'s exact ordered-pre-execute sequencing,
  the honest fix is an upstream patch exposing a public staged-scheduler seam —
  deliberately not done here, because it is not needed for any BRG gate and the
  task said to avoid upstream changes unless genuinely required.
