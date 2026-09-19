# M6 — 30 hard capacity + UI sustained N

Branch `ipython-native`. All work below is on the working tree; nothing is pushed.

| Item | Value |
|---|---|
| Repo HEAD at measurement | `1d36130f0b97cc927d3750f5fb6071af19dced6e` |
| Branch | `ipython-native` |
| DSH checkout | `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| Test command | `cd packages/dsh-daily-work && vitest run src/<file>.test.ts --maxWorkers=1 --no-file-parallelism` |
| Typecheck command | `cd packages/dsh-daily-work && tsc -p tsconfig.check.json` |
| M6 test result | **58 passed / 0 failed** (25 capacity + 33 target-setting) |
| M6 typecheck | **0 errors in M6 files**; 7 errors elsewhere, all in other agents' untracked in-flight files |
| Evidence | `tests.txt`, `tsc.txt`, `source-digests.txt` in this directory |

---

## 1. What was actually implemented

### 1.1 The capacity gate — `src/capacity.ts` (new, 533 lines)

A **host-wide** child slot ledger, mounted once by the host profile, plus the
deployment depth ceiling.

`HARD_CHILD_CAPACITY = 30` is a module constant, not a config key. The UI can
choose a target `N` in 1..30; `N` is bounded by this number and cannot change it.

The ledger keeps two maps and derives one number:

```
occupied = liveChildren + unbackedReservations + unknownQuarantined
```

with a **folding rule** that matters: a task slot whose child is live is folded
into the physical child rather than added to it. Counting both would report one
child as two and *halve* the effective capacity — the opposite failure from
oversubscribing and just as wrong. A task slot in `unknown_quarantined` is the
one case that DOES add even when a child is live, because the plan's rule is
"对账不明的执行者不提前 release".

### 1.2 The depth ceiling, at the deployment boundary

`assertDepthWithin` reads the child's own durable `delegationDepth` via
`delegationDepthOf`, and refuses when it exceeds the host's `maxDepth`. The
`maxDepth` value comes from **host config**, never from a request.

### 1.3 The target setting — `src/target-setting.ts` (new, 241 lines)

`ctx.settings.installSection(owner, 'daily-work', schema, entry, hooks)` with the
exact shape `SubagentRuntime` uses. `target()` is a **function delegating to a
`settingsSource` thunk**, so a write takes effect on the next read with no
restart. `set(value, expectedRevision)` is the fenced writer.

### 1.4 Host wiring (minimal diff)

- `WorkServiceConfig.targetChildren` doc rewritten to state it is the
  composition default and the live value is the setting.
- `WorkServiceConfig.subagentProvider` made **optional** with a
  `DEFAULT_SUBAGENT_PROVIDER = 'spawn'` fallback. Reason recorded in the field
  comment: it is the only field with a safe default, because it is read only when
  the service installs its own default launch port and that path already returns
  early when no subagent runtime is mounted. This was also the cause of **30
  typecheck errors** across 15 test files from commit `2d4534f`; the default
  clears all 30.
- `WorkService` gains `gate`, `targetSetting`, `childRefusals`, and the methods
  `targetActiveChildren()`, `installTargetSetting()`, `capacity()`,
  `capacityGate`, `refusals()`, `setTargetChildren()`, `resolveRequestedTarget()`.
- `admit()` takes the host slot **before** the record write and releases it if
  the write refuses — the plan's "pre-publication同步reserve；失败清理后release".
- `transition()` calls `syncSlotToState()` so the bucket follows the task state.
- `drain()` adds a host-capacity check so a refusal reports
  `host_capacity_reached` rather than surfacing as a generic admission error.
- `host-plugin.ts` calls `service.installTargetSetting(ctx)`.

### 1.5 UI wiring — the answer, and it is "no new card is needed for the existing namespace"

**Determined from source, not assumed.** The relevant facts:

- `SubagentLimitsCardController` binds namespace `'subagent'` and renders
  `maxActiveSubagents` through `CardForm` + `numberField`
  (`packages/client/ui-settings-plugins/src/client/subagent-limits-card-controller.ts`).
- Pages register into the `plugins.item` slot **only while the Host serves their
  namespace** (`ui-settings-plugins/src/client/index.ts`: `describeFace` →
  `sync()` → `available = namespaces.some(ns => served.has(ns))`).
- `CardForm.save()` → `scope.set(field, value)` → `SettingsScope.mutate(ops)`
  which passes `expectedRevision ?? pendingRevision ?? snapshot.revision`
  (`ui-settings/src/client/settings-scope.ts:130`). So the shipped card path is
  **already revision-fenced**.

**Decision: a new namespace `daily-work` with its own section, and NO new card
written in this milestone.** Reasons, both from the source above:

1. `subagent` is owned by `SubagentRuntime`. Its `maxActiveSubagents` is a
   per-family continuable pool bound — a different quantity from this
   deployment's sustained host target. Two owners on one document section is not
   possible (`register` throws on a duplicate namespace), and putting the target
   there would let the control that edits `maxActiveSubagents` *appear* to edit
   the hard cap.
2. Because the page registry is keyed on the namespace being served, a new
   `daily-work` namespace becomes editable through the **existing** card
   mechanism as soon as a card binds it — and the binding is one line:
   `new SubagentLimitsCardController(ctx.settingsScope.bind({ namespace: 'daily-work' }))`
   with a `limitField('targetActiveChildren', 1)` spec, reusing the same
   `CardForm`/`numberField`/`PluginConfigForm`/`ValueField` stack and the same
   `save`/`discard` footer. The controller class is parameterised by its scope, so
   the same class serves either namespace.

**What is NOT done, stated plainly rather than implied:** the `daily-work` card
entry is not registered in `packages/client/ui-settings-plugins/src/client/index.ts`.
That is a UI-package change outside this milestone's file ownership, and it is
the one remaining step for UI-01 to be end-to-end in the browser. The host side
it depends on — namespace served, revision published, write fenced, change live
— is implemented and tested.

---

## 2. The five creation paths, and what actually covers them

Traced to each path's Agent materialization:

| Path | Entry point | Reaches | Covered by |
|---|---|---|---|
| continuable | `subagents.startContinuable` (`continuation.ts:104`) | `materialize` → `agents.create` | gate + depth ceiling |
| one-shot | `subagents.start` (`index.ts:591`) | `provider.start` → `agents.create` | gate + depth ceiling |
| cold resume | `sendMessage` → `coldResume` (`continuation.ts:406`) | `materialize` → `agents.resume` | gate + depth ceiling |
| workflow/PTC | `startChild` (`workflow-ptc/src/host.ts:197`) | `subagents.start` (no `maxDepth`) | gate + depth ceiling |
| direct SDK | `ctx.agents.create` / `resume` (`core/agent/src/index.ts:171`) | — | gate + depth ceiling |

**The one seam that covers all five.** Every in-process child passes through
`AgentRegistry.create` or `resume`, and both funnel into `agents.announce()`
(`core/agent/src/index.ts:534`), which dispatches the **`serial`** event
`agent/created` at `:547`. A throwing serial listener rejects the announcement —
quoted from source: *"@returns completion of the serial creation listeners; a
listener failure rejects"* and *"Reject if the id is already registered or a
serial `agent/created` listener fails"* — and `AgentLoop.publish` is
rollback-covered around it. So refusing in that listener makes the **creating
call reject** and the caller receives no child.

**The honest limit of that point, stated rather than glossed.** The agent has
already been inserted by `enter()` when the listener runs, so it is briefly
visible in the registry store during the rollback window. DSH pairs that window
with `agent/disposed`, which is why the ledger is keyed by child id and released
from `agent/disposed`: a refusal takes no slot, so a rollback's disposal can never
free a slot the gate never took. `releaseChild` is deliberately silent on a miss.

**What the gate is NOT.** It counts children materialized in THIS host process.
An out-of-process provider (`acp`, `codex`, `claude-code`, `dsh-sdk`) publishes no
local Agent and consumes no local slot; its capacity belongs to that runtime. This
is stated in the module header so "global" is not read as "network-wide".

**Fork sessions are deliberately not counted.** A session fork sets
`parentSession` + `isSeeded` but neither `origin: 'subagent'` nor a delegation
depth (`api/session-controller/src/commands.ts:264`), so `isSessionBackedChild`
returns false. Over-counting forks would refuse legitimate user work.

---

## 3. Test results, and the N used for each property

Smallest N that proves each property, as required. **No test spins up 30 real
children.**

### `src/capacity.test.ts` — 25 passed

| Test | N | Why that N |
|---|---|---|
| capacity is the constant 30 | — | the constant itself |
| **31st and 32nd refused, never > 30** | **30** | the cap IS the property; synthetic occupancy makes "30 occupied" exact instead of a race |
| `occupied` = all five buckets | 5 | one of each bucket the plan names |
| task slot folds into its live child | 2 | needs a fold + one refusal |
| a requested-but-unconfirmed cancel occupies | 2 | holder + refused admission |
| a waiting assignment still occupies | real agents | the child is parked in its provider call |
| physical slot releases on `agent/disposed` | real agents | the release edge itself |
| continuable path takes a slot | real agent | the path, not the number |
| **one-shot path takes a slot** | real agent | this path had NO capacity check before |
| direct AgentFactory path takes a slot | real agent | the common funnel |
| **workflow/PTC shape (no `maxDepth`) is refused** | 1 | depth is independent of N |
| fork does NOT consume a slot | real agent | negative control |
| **`maxDepth: 99` refused** | 1 | the caller-lift defect |
| **omitted `maxDepth` refused** | 1 | the omission defect |
| depth refusal costs no slot | 1 | leak check |
| depth-1 child IS admitted | 1 | control arm: a gate refusing everything would pass otherwise |
| one root reaches target 3 | 3 | smallest N showing admission + refusal with real children |
| **ready shortage at N=30 with 2 ready** | 30 target, 2 real | proves no filler agents; only 2 real children created |
| root not counted, not starved | — | `rootAvailable` stays 100 |
| host cap is host-wide (two roots) | 30 | two roots cannot each hold a full pool |
| **two REAL roots share one ledger** | 3 | real children from two roots; runtime configured for 64, so only the host ledger can refuse |
| idle historical Session is not active | 2 | live + idle |
| refusal rejects the creating call | 1 | pre-publication, depth arm |
| capacity refusal rejects the creating call | 1 | pre-publication, capacity arm |
| **CAP-08 raise/lower keeps running children** | 3→5→2→4 | smallest sequence showing raise, lower, and re-maintain |

### `src/target-setting.test.ts` — 33 passed

Covers: the real `installSection` seam and `applies: 'live'`; live read with no
restart; persistence and reconnect; revision read; fallback with no provider;
**14 illegal values** (`0`, `31`, `1000`, `2.5`, `NaN`, `Infinity`, `-1`, `'12'`,
`'twelve'`, `null`, an object, an array, a boolean, a function) refused at the
host; the schema refusing out-of-range values that bypass the owner check;
boundaries `1` and `30` accepted; the validate hook; the client-side parse; **one
success + one stale** for two same-revision writers; `SettingsConflictError` with
`code: 'SETTINGS_CONFLICT'` and `expected`/`actual`; a 5-writer burst yielding
exactly one success; the unfenced path; a never-existent revision; the `work`
tool's parameter set asserted exactly as `['action','childId','goal','taskId']`
with 11 forbidden names checked; and the tool source asserted to reference no
target/budget symbol.

---

## 4. Honest gaps — what is NOT proven

| # | Gap | Status |
|---|---|---|
| 1 | **UPG-07: 30 real children on an authorized live provider.** | **BLOCKED_EXTERNAL.** No provider budget is authorized on this machine. The scripted adapter is the provider boundary, not a second model loop, and it proves the *mechanical* admission and top-up behaviour — it does not substitute for this gate, and is not reported as if it did. |
| 2 | **UI-01 end-to-end in the browser.** | **PARTIAL.** The host half is implemented and tested (namespace served, revision published, write fenced, change live). The client card entry for `daily-work` is not registered in the UI package — one line, outside this milestone's file ownership. §1.5 states the exact change. |
| 3 | **RES-05: 31 kernels' RSS.** | **NOT_RUN.** This is the resource measurement the plan asks for at M6.10; it needs 30 real children, so it is blocked by the same external budget as #1. |
| 4 | 30 real children refused at the *live* deployment cap of 30. | **PARTIAL — and this is the most important limitation to read.** The cap constant is asserted to be 30, and "31st refused, never > 30" is proven at N=30 with synthetic occupancy. The *live* refusal tests run at N=1/3 because a gate's capacity is a constructor argument and driving 30 real agents to prove a refusal that the synthetic test already proves exactly would spend 30 agent lifecycles for no additional information. A reader must not read "30 real children were refused" out of this file. |
| 5 | `maxActiveSubagents` remains per-family at the DSH level. | **NOT FIXED UPSTREAM, and deliberately not worked around by editing DSH.** The host ledger is the cap; the per-family pool still exists beneath it and is now redundant rather than authoritative. `cordis.patch.yml` still sets it to 10, which is now a *lower* bound than the host cap — a configuration inconsistency worth a follow-up. |
| 6 | The `daily-work` target is not yet read by `createRun` from the settings section in a *composed* profile. | **IMPLEMENTED BUT UNVERIFIED IN A REAL BOOT.** `installTargetSetting` is called by `host-plugin.ts` and tested directly; it has not been re-verified inside `dsh --profile daily-candidate`. |

---

## 5. Two existing assertions this milestone had to CHANGE, and why that is not weakening

`src/isolation.test.ts` C12 held three tests whose **names claimed the property
this milestone delivers** while their bodies documented the defect:

- `'refuses the grandchild even when the CALLER supplies a larger maxDepth'`
  asserted that with `99` the depth-2 child **IS created**.
- `'omitting maxDepth does NOT lift the deployment cap, because our port never omits it'`
  asserted that an omitted cap **IS not a refusal** at the DSH seam.
- `'accounts for the workflow/PTC path...'` asserted that a workflow **DOES**
  create a depth-2 child.

All three now assert the refusal, at the creating call, with the child absent from
the registry. This is the assertion becoming **stronger**, not weaker: the tests
were documenting a known gap (G-SEAM-18) and now verify its closure. The
mechanism that changed is the deployment boundary, not the test. The fourth C12
test, `'records the deployment depth on the run'`, is unchanged and still passes.

`docs/GAPS.md` G-SEAM-18 should be updated from OPEN to RESOLVED for the
`maxDepth` half; the per-family-pool half remains OPEN (gap #5 above). **This
document is not edited here** because `docs/` is outside this milestone's stated
file ownership.

---

## 6. One thing worth flagging to whoever reads this next

The `subagentProvider` field added in commit `2d4534f` was **required** and
**unset in 15 test files**, producing 30 typecheck errors across the package.
Making it optional with a defaulted value cleared all 30 and is defensible on its
own terms (it is the only field with a safe default). But the underlying fact is
that `tsconfig.check.json` was reporting a broken tree for at least one commit
before this milestone started, which means any gate citing "typecheck clean"
between `2d4534f` and now was reading a red tree. Worth knowing when reading other
milestones' evidence.
