# P7 / UI-ACTIVE-RUN + UI-DEFAULT — measured evidence

Slice: **P1.7** — "the setting called *target active children* is not the active
run's target, and there is no Work UI card."

Worktree `D:\DSH\work\wt-p7`, branch `wt/p7`. Every number below came from a
command run in that tree; the commands are named beside the numbers.

---

## 1. THE BEFORE/AFTER, which is the point of the slice

### BEFORE

`packages/dsh-daily-work/src/target-setting.ts` defined a global
`daily-work.targetActiveChildren`, documented as "The UI-settable sustained child
target". Runtime admission read **`RunRecord.requestedTarget`** instead
(`host.ts:1402`, inside the storage-domain update: `const target =
record.requestedTarget`). The setting was read in exactly one place — when a NEW
run was created (`host.ts:522`, `resolveRequestedTarget`) — and `onChange` was
empty.

**The observable consequence, stated as the user would meet it:** a user who
changed that setting while a run was live would reasonably expect the live run to
move. Nothing moved, and nothing said so. The name asserted a relationship the
code did not have.

### AFTER

| | before | after |
|---|---|---|
| setting field | `targetActiveChildren` | `defaultTargetActiveChildren` |
| handle read | `target()` | `defaultTarget()` (`target()` kept as a deprecated alias for P5's `host.ts`) |
| a document still using the old key | silently carried through the non-strict schema resolver and IGNORED (measured: `{targetActiveChildren:12}` over base 6 resolves to `{"targetActiveChildren":12,"defaultTargetActiveChildren":6}`) | refused **by name**, on the read path |
| active run's target | reachable only by `/work target N` | unchanged — reachable only by `/work target N` |

The split is now two values that can be moved independently and are stored in two
different files:

* `defaultTargetActiveChildren` — the settings document, revision-fenced, 1..30.
* `RunRecord.requestedTarget` — the Work store, changed only by `/work target N`.

**Evidence that they are independent** — `p7-ui-target-split.test.ts`, arm "a
setting write and a target command move DIFFERENT stored values": the setting is
written to 20 and the run to 7, and both reads hold. A single conflated value
could not carry both.

**Evidence of the two oracles V5 section 18 names** (`/work` lines driven through
the real `CommandRuntime`, which is what `ctx.remote.commands.execute` reaches
host-side):

* `UI-DEFAULT` — "changing default only affects later runs": the arm writes the
  global setting to 12 while a run holds 4, and asserts the live run's durable
  `requestedTarget` **stays 4** while a *second* session's run created afterwards
  reads **12**.
* `UI-ACTIVE-RUN` — "Apply Target changes selected run's durable requestedTarget
  through CommandRuntime": `/work target 9` moves the run's durable value to 9 and
  leaves the global setting untouched (asserted against the settings document's
  own `user` layer, not just the live read).

### The mutation test (V5's rule: a passing test you did not watch fail is not evidence)

* Reverting `DEFAULT_TARGET_FIELD` to the old name → `p7-ui-target-split.test.ts`
  **4 failed / 5 passed**.
* Removing the read-path legacy check → the legacy arm goes **1 failed**.
* Both restored; green again. (Runs recorded in the commit messages.)

---

## 2. WHAT THE PINNED CHECKOUT ACTUALLY DOES (`SOURCE_FACT`)

| claim | where |
|---|---|
| `installSection` is the settings seam; it passes `validate` into `register` and calls `setSource`/`onChange` | `packages/settings/settings/src/index.ts:472-496`, `:481-483` |
| the schema resolver is **non-strict** — undeclared keys are merged through | `vendor/schemastery/src/index.ts:752-763` (`if (!strict) merge(result, data)`) |
| admission reads the run's own durable target, not any setting | `packages/dsh-daily-work/src/host.ts:1402` |
| a client row requires `dsh.client` with `platform: 'web'` **and** an `exports["./client"]` **and** a readable bundle | `packages/client/modules/src/index.ts:781-816`, `:916-929` |
| a loader row whose name is a **subpath** is "permanently not a client row" — classified before any filesystem work | `packages/client/modules/src/index.ts:829-833` + `:786-791` |
| the browser reaches commands through `remote.commands.execute(sessionId, line, attachments)` | `packages/interaction/commands/lib/typert.remote-client.d.ts:15`; called at `packages/api/session-controller/src/client/sessions/session.ts:373` |
| `SubagentLimitsCardController` binds the **`subagent`** namespace | `packages/client/ui-settings-plugins/src/client/index.ts:71` |
| the shipped settings page roster is **HARDCODED to four namespaces** (`shell`, `agent-loop`, `subagent`, `web-search`) | `packages/client/ui-settings-plugins/src/client/index.ts:104-122` |

**V5's warning is confirmed, and the reason is stronger than "no card was
written":** a host-plane settings namespace does **not** automatically produce a
browser form. `installSection` publishes a namespace to the settings *document*;
rendering it needs a client bundle that registers a card into a slot. The four
shipped cards are hardcoded by namespace, and `daily-work` is not one of them.

---

## 3. DOES ANY BROWSER CARD EXIST FOR `daily-work`? — NO, measured

`node qualification/results/P7-ui/probe-client-discovery.mjs`
(output committed as `client-discovery.json`). It drives the pinned checkout's
**own** manifest functions against this project's real `package.json` and the real
loader-row names from our bundle patch:

```
"dsh-daily-work declares dsh.client":            false
"dsh-daily-work client bundle exists":           false
"every loader row is a subpath":                 true
"any browser card exists for the daily-work namespace": false
```

Three independent blockers, all measured:

1. **No `dsh.client` declaration** and no `exports["./client"]` in
   `packages/dsh-daily-work/package.json`.
2. **Every loader row this project inserts is a subpath** — `dsh-daily-work/host`,
   `/web-search`, `/history`, `/tool-protocol-guards`, `/writers`, `/data-host`,
   `/programmatic-scope`, `/no-sandbox-contract`. `locatePkgJson` bails on a
   subpath before any filesystem work, so the scan would never reach a manifest
   even if one declared a client half.
3. **The build toolchain is absent from this tree.** Measured by resolution:
   `react`, `react-dom`, `tsdown`, `@deepseek-ai/dsh-client-store` and
   `@deepseek-ai/dsh-client-ui-settings` are all **UNRESOLVED** from
   `packages/dsh-daily-work`. A client half cannot be typechecked, let alone
   bundled, here. (`tsdown` and `react` exist in the pinned checkout, which is
   READ-ONLY and whose `lib/` is gitignored — a bundle built there would not be
   committable from this repository.)

### The control arm: why the declaration was NOT added

Adding `dsh.client` without a committed, buildable bundle is a **regression**, not
a partial fix. Measured in the same probe:

```
"1. parseDshClient accepts the declaration":                              true
"2. clientExportOf returns undefined without exports[\"./client\"]":      true
"2. so resolveMeta (index.ts:803-806) throws ...":                        true
"2b. clientExportOf throws on a non-string default":                      true
"3. the declared bundle path exists today":                               false
"3. lib/ is gitignored, so it is absent in a fresh clone":                true
```

A declaration with no `./client` export throws in `resolveMeta`; one with the
export but no file throws `MissingClientBundleError`, which the constructor's
activation pass aggregates into **one loud throw that fails the `modules` fiber**
(`index.ts:113-123`, `:552-557`) — the fiber the entire browser surface depends
on. So the honest choice is to build the card's logic and wire it to the real
authority edge, and **report** the bundle as the remaining step rather than break
the web boot.

**A correction, recorded rather than silently fixed:** the first version of this
probe attributed the throw to `clientExportOf` and measured `false`; the throw is
one level up in `resolveMeta`. Corrected after reading the call site.

---

## 4. WHAT WAS ADDED: the card's action layer, on the ONE authority edge

`packages/dsh-daily-work/src/ui-card.ts` — the part of a card that can be wrong in
a way a render cannot show: which line each control emits, which session it is
addressed to, how the host's outcome arms map, and how the display reads the
host's own status text.

V5 section 13: *"UI actions must use the same human authority plane as slash
commands: prefer `ctx.remote.commands.execute(...)` ... No separate authorization
RPC."* The module takes `execute` as a parameter and holds **no other
capability** — no service reference, no run-record write, no second RPC. Its
whole action surface is one function, so "one authority edge" is structural
rather than a claim. Writer R4 built that edge (`command-work.ts`, evidence
`qualification/results/R4-authorization/`); this **extends** it and adds no
second one.

Controls → lines (asserted against the host's own `parseWorkCommand`):

| control | line |
|---|---|
| Start Work | `/work start` (or `/work start N`) |
| Apply Target | `/work target N` |
| Stop Work | `/work stop` |
| Status | `/work status` |

Session scoping (V5: *"If multiple roots exist, card is scoped to
selected/current Session"*) is enforced by **capture**: the session id is fixed at
construction and the action face exposes no way to name another one. Tested by
asserting the exported key set.

### The display, and the fields it honestly cannot show

The card parses the host's `/work status` text rather than reading the record, so
the card and the slash command cannot disagree — a card that read the record
would be a second opinion and would drift the first time admission changed.

**Fields V5 section 13 asks for that `/work status` does NOT report** (measured
against `renderStatus`, `command-work.ts:180-193`): `ready`, both `waiting`
counts, `heldReservations` (the authoritative occupancy), `targetOvershoot`, and
global hard-cap occupancy. The card reports these as **unreported** rather than
rendering `0`, and an absent field parses as `undefined`, never `0` — the same
distinction `counting.ts` draws between `capacityDeficit` (clamps) and
`heldReservations` (does not).

**SEQUENCING, as the dispatch instructed.** `ready` is exactly the field writer
**P5** is concurrently adding as a durable READY queue. Measured at P5's HEAD
`72165a1` ("WORK-READY step 3+4: requestDrain, the oldest-ready pass, and the
completion observer"): their `host.ts` now has `record.readyAssignments`,
`submitReady` and `ReadyAssignment`, but their `command-work.ts:renderStatus`
**still emits no `Ready:` line**, so nothing is displayed for it by any surface
yet. This slice therefore **does not invent a name** for P5's concept — it
displays what the command plane reports and names `ready` as pending.

**The list cannot go stale.** It is checked against real host output by an arm
with its own control: if P5 adds a `Ready:` line, the test fails and the list must
shrink; a control arm confirms the same check *does* find `Target:`, so a list of
typos cannot pass by matching nothing. (The first version of that check compared
bare words and failed on a real collision — `target overshoot` contains `target`,
and `Target:` **is** a rendered line. The mapping is now an explicit line prefix,
and the correction is recorded in the module.)

---

## 5. TEST RESULTS (one file at a time, as the CPU discipline requires)

```
node node_modules/vitest/vitest.mjs run src/target-setting.test.ts   -> 33 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/p7-ui-target-split.test.ts -> 10 passed / 0 failed
node node_modules/vitest/vitest.mjs run src/ui-card.test.ts          -> 15 passed / 0 failed
node helpers/typecheck.mjs   -> PASS (2 packages, 96 + 30 files, tests included)
```

`pnpm typecheck` is the ONE official command and is quoted above rather than
`tsc -p tsconfig.json`, which excludes tests and is the F10 / ID-05 false pass.

Control arms inside the tests (a gate that never fires and an absent gate produce
identical evidence):

* the host parser **rejects** lines the card must never emit (`/work frobnicate`,
  `/work target`, `/work start 0`, `/work stop now`);
* the legacy-key arm has a paired control where the **same rig with the new key
  reads cleanly** — without it, a guard that refused every document would pass;
* the card's bounds are asserted **equal** to the host's `MIN`/`MAX`, so the
  restated constants cannot drift silently.

---

## 6. THE FINDING THAT CHANGED THE DESIGN (recorded because it was a real bug in my own fix)

The first version refused the pre-split key in the section's `validate` hook.
**MEASURED: that does not work, and is worse than the problem.** When a `validate`
hook throws, the `owner.inject(['settings'], ...)` activation turn's fiber FAILS:
`register` never completes, `describe()` reports **no `daily-work` namespace at
all**, and `setSource` is never called — so every read silently falls back to the
composition entry. The guard would have converted "the stored value is ignored"
into "the namespace is gone **and** the stored value is ignored": strictly worse
and equally invisible.

The refusal now runs on `TargetSettingHandle.defaultTarget`, which is reachable
precisely because the section **does** register and the non-strict schema carries
the undeclared key into the resolved value. Mutation-tested.

---

## 7. FILES

```
packages/dsh-daily-work/src/target-setting.ts             the rename + the read-path refusal
packages/dsh-daily-work/src/target-setting.test.ts        field renamed (33/33 still green)
packages/dsh-daily-work/src/p7-ui-target-split.test.ts    NEW: the two V5 oracles (10 arms)
packages/dsh-daily-work/src/ui-card.ts                    NEW: the card's action + display layer
packages/dsh-daily-work/src/ui-card.test.ts               NEW: 15 arms
qualification/results/P7-ui/probe-client-discovery.mjs    the client-discovery measurement
qualification/results/P7-ui/client-discovery.json         its output
qualification/results/P7-ui/report.md                     this file
```

**NOT edited, deliberately:** `host.ts`, `capacity.ts`, `record.ts`,
`command-work.ts` — writer P5's region this round.
