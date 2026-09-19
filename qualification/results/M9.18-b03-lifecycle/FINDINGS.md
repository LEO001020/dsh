# M9.18 — B03 plugin lifecycle, three load/unload cycles

**Status: PASS.**

## What the gate asks

`load → execute → unload → load`, three times, including work still awaiting, and
then: is new admission closed, are owned resources released, and are there orphan
timers / listeners / domain handles?

## How it is measured

`qualification/runners/verify-b03.mjs` runs **inside a real `dsh --profile daily`
boot**, so the module identity it cycles is the one the profile resolver actually
loaded (proven separately in M9.17: one realpath per peer, all built output). A
lifecycle test in a bare vitest process would cycle a *different* module instance
and could pass while the deployed graph leaks.

Each cycle mounts a plugin owning a long-lived `setInterval`, requests disposal
while a 250 ms await is still pending, then awaits both. `ctx.fiber.dispose()` is
the documented unload path; there is no `ctx.stop`, and reaching for one would be
inventing an API.

## Result

| Measure | Control (empty plugin) | Arm (timer-owning body) |
|---|---|---|
| Total resource series | 10 → 12 → 12 → 12 | 12 → 12 → 12 → 12 |
| Per-cycle delta | +2, 0, 0 | 0, 0, 0 |
| Final-cycle growth | 0 | **0** |
| `Timeout` count series | — | 0 → 0 → 0 → 0 |
| **Timer leak** | — | **0** |
| Domain usable after cycles | — | **true** |
| Live resources at end | `PipeWrap×2, TCPServerWrap×1, FSEventWrap×9` | identical |

The disposer clears the timer: the `Timeout` count returns to its pre-mount value
and does not climb by one per cycle. The flat tail is the leak signal — each cycle
returns the process to the state the previous cycle left it in.

## Two measurement errors found and corrected

Both were mine. Both would have produced a **false FAIL** if left in.

1. **Wrong baseline.** The first version compared every cycle against a
   pre-cycle baseline and reported **"9 orphan handles"**. The real series was
   3 → 12 → 12 → 12: a single jump, then flat. That is the signature of one-time
   lazy initialization in the host, not per-cycle leakage. The leak signal is the
   delta **between cycles**.

2. **Blind to the resource the gate names.** `process._getActiveHandles()` does
   **not** report timers — the exact resource this gate asks about. Corrected to
   `process.getActiveResourcesInfo()`, which does. The earlier version could not
   have detected a leaked interval at all.

A **control arm** was added and runs **first**, so one-time host initialization is
charged to the control rather than to the extension. The control shows +2 on its
first cycle (lazy `FSEventWrap` watchers) and the extension arm then runs against
an already-warm host — which is the state a real reload happens in. Without the
control, the +2 would have been misattributed to the extension.

## What this proves

- Three load/unload cycles complete, with work still awaiting, and release
  everything they took: no orphan timer, no listener growth, no handle growth in
  steady state.
- The shared storage domain survives the cycles and remains usable
  (`listRunIds()` returns cleanly). A lifecycle that "cleans up" by breaking the
  shared host handle would not be a pass either.
- Disposal is not defeated by a pending await.

## What this does NOT prove

- It does not prove the host's own **watcher-driven** reload of the deployed
  profile. These cycles are driven explicitly; a watcher-triggered reload is a
  different path and is not exercised here.
- It does not prove "new admission is closed" by itself. That property is owned
  by `drainContinuableDescendants` and is proven in the scheduling and isolation
  suites, not here.
- Resource counts are process-wide, so a leak in an unrelated concurrent plugin
  would be attributed to the arm. The control arm bounds this: both arms share the
  same process and the control is measured first.
