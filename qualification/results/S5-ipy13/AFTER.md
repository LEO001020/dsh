# IPY-13 — AFTER state: late output is classified separately and never rides another cell

**Date:** 2026-09-20. **Tree:** `D:\DSH\work\wt-s5` @ `wt/s5`.
**Identity measured under:** THIS worktree's `KernelHost` -> `broker.py` ->
`jupyter_client` -> `ipykernel` 7.3.0, Python 3.14.3. Every number below is a
run of a command in this tree, not a reading of source.

---

## 1. The oracle, and its three clauses

From `qualification/specs/acceptance-spec.trusted-local-v2.definition.json`:

> **stimulus:** "A background thread writes to stdout after the cell has returned;
> then start another cell while the thread is still writing."
> **oracle:** "The post-return write is reported as late/unattributed and does
> not appear in any later cell's result. A write landing DURING a later cell is
> reported as undecidable rather than attributed. A claim that the originating
> cell's parent id is always preserved is NOT PASS, because it is false for a
> thread started with an empty context."

| clause | before | after |
|---|---|---|
| post-return write is late, rides nothing | HELD | HELD (unchanged) |
| a write DURING a later cell is undecidable, not attributed | **FAILED** | HELD |
| no general claim that the origin is preserved | n/a | HELD — the case where it is not preserved reports UNDECIDABLE |

## 2. BEFORE / AFTER on the same instrument

`s5-ipy13-before.ts` run against this tree's real broker. The same stimulus, the
same three arms.

```
BEFORE (before.json, committed at c0589ea)
  arm2_cellB_stdout = "...arm2-tick 2\nS5-BEFORE-STRADDLER\narm2-tick 3..."
  arm2_cellB_contains_straddler = true
  arm2_late                     = []            <- the late channel is EMPTY
  verdict = DEFECT_REPRODUCED

AFTER (same instrument, after the fix)
  arm2_cellB_stdout = "arm2-tick 0..4\narm2-cellB-settled"   <- no straddler
  arm2_cellB_contains_straddler = false
  arm2_late = [{ cellId: "..._4", text: "S5-BEFORE-STRADDLER\n", epoch: 1 }]
  verdict = defect not reproduced
```

## 3. The fix, and why it is where it is

`broker.py` gains a self-contained block (the source of a kernel-side bootstrap,
its generator, a marker read-back, and a status field). The bootstrap is injected
through `KernelManager.start_kernel(extra_arguments=)` ->
`--IPKernelApp.exec_files=`; both are public and verified in the pinned source
(see `MECHANISM.md` §4).

It does three things, and the third is what satisfies the oracle's warning:

1. a write from a cell's own thread is left **entirely alone** (ipykernel's own
   ContextVar resolves there — measured);
2. a write from a thread **the cell started** (or a descendant of one) is stamped
   with **that cell's** header, so `t.start(); t.join()` output stays in its cell;
3. a write with **no discoverable origin** is stamped with a sentinel
   (`dsh:background`) that matches no cell, so the broker's **unchanged** router
   already reports it as `late_output`.

No user code is wrapped. The cell body runs exactly as IPython would run it.

## 4. What the gates measure

| gate | command | result |
|---|---|---|
| the fix | `vitest run src/s5-ipy13.test.ts` | 1 passed — straddler undecidable, late channel carries it, cell B's five ticks intact |
| the oracle in the spec gate | `vitest run src/v3-spec-gates.test.ts -t IPY-13` | 2 passed — CLAUSE 1 unchanged, CLAUSE 2 now `clause_met` |
| the earlier requirement | `vitest run src/requirements.test.ts -t "requirement 9"` | 2 passed |
| the whole spec-gate file | `vitest run src/v3-spec-gates.test.ts` | 12 passed |
| neighbours | `requirements.test.ts` 19/19, `faults.test.ts` 11/11, `lifecycle.test.ts` 15/15, `smoke.test.ts` 2/2 | 0 red |
| typecheck, tests INCLUDED | `node <dsh-src>/node_modules/typescript/bin/tsc -p tsconfig.check.json` | exit 0, 0 errors |
| typecheck, build config | `tsc -p tsconfig.json --noEmit` | exit 0 |

TypeScript 6.0.3 is not installed in this worktree's `node_modules`, so the
compiler was run from the pinned checkout's install
(`D:\DSH\src\dsh-src\node_modules\typescript\bin\tsc`, `--version` 6.0.3). It is
the same major the package declares (`^6.0.3`). The two probe `.ts` files under
`src/` are picked up by `tsconfig.json` and emit into `lib/`, which is the
convention already set by `r5-f2-before.ts`, `t7-measure.ts` and the
`v4-bridge-*-probe.ts` files.

### Controls that must not regress, all in `s5-ipy13.test.ts`

- **ordinary in-cell print** → in the cell;
- **`thread + join()` inside one cell** → STILL in the cell. This is the arm a
  naive "the contextvar is unset, so it must be background" gate breaks; the
  bootstrap exists in this shape because of it;
- **a descendant (grandchild) thread** → in the cell it descends from;
- **`_thread.start_new_thread`** → undecidable under the named sentinel;
- **a restart** → the bootstrap is re-injected and the flag is re-established.

### Twelve semantic traps, all surviving

`s5-ipy13-traps-probe.json`: top-level `await`, `%who`, a traceback with source
location, the displayhook, `print(sep=, end=, file=)`, `sys.stdout.write`, a
subprocess writing to the inherited stdout, an `asyncio.create_task` writer,
`logging` to stderr from a thread, a thread outliving its cell and joined by a
LATER cell, a thread started before any cell, and a 5 KB single write.

## 5. Mutation testing — the record, including what did NOT go red

Each mutation was applied to `broker.py`, the gate run, then restored and the
hash verified. Restore hashes: `db24b46e…` (before the grandchild change),
`e562dfd0…`, `ce3ffa0c…`.

| mutation | effect | gate |
|---|---|---|
| M1 bypass the write-stamping path | straddler rides cell B again; `lateCount 0` — byte-for-byte the BEFORE defect | **RED** |
| M2 naive gate: never carry the origin into threads | straddler fixed, but `thread+join` output LOST from its own cell | **RED** |
| M3b hardcode the load report to `false` | the report is not a measurement | **RED** |
| M4 disable grandchild-origin propagation | grandchild write lost from its cell | **RED** |
| M6 drift the sentinel in `broker.py` only | a caller would never match an undecidable frame | **RED** |
| M5 remove the pre-restart marker invalidation | restart still succeeds and re-writes the marker, so arm F still passes | **NOT RED — see below** |

**M5 is an honest gap.** The invalidation guards a failure path (a restart whose
re-injection fails) that I could not induce through the real kernel path, because
`restart_kernel` replays `_launch_args` successfully every time here. The hazard
itself IS demonstrated directly, at unit level, in
`s5-ipy13-restart-probe.json` and by exercising the helpers: a stale marker reads
as `true`, indistinguishable from a fresh load. So the invalidation is a
defensive correction with a demonstrated hazard and **no gate that fails without
it**. It is kept because it is cheap and makes the post-restart read a fact about
the new kernel, but it is not claimed to be gated.

**M3a (`hardcode true`) also does not go red**, for the same structural reason:
the bootstrap loads successfully in every arm, so a hardcoded `true` is
accidentally correct. The two-sided answer is the negative probe below, which
makes `false` reachable.

## 6. The negative control

`s5-ipy13-negative-probe.py` points `exec_files` at a path that does not exist —
how a real failure would occur — and measures:

```
attributionBootstrapLoaded = false     <- the marker IS a fact about the kernel
defect_returned            = true      <- the straddler rides cell B again
kernel_alive               = true      <- IPython logged it and carried on,
                                          which is WHY the marker exists
```

So the bootstrap is load-bearing: with it absent, nothing else in the system
separates the two writes.

## 7. PRODUCT REACHABILITY — the part that matters

**Classification: REACHABLE through the real kernel path. Delivery to the model:
NOT REACHABLE.** These are two different facts and must not be merged.

What IS reached by the product: the tool (`ipython-tool.ts`) -> `KernelService`
(`kernel-plugin.ts`) -> `KernelHost` (`kernel.ts`) -> `broker.py` -> kernel. The
classification this slice fixes is produced on that path and is measured through
it (`s5-ipy13.test.ts` drives `KernelHost`; `s5-ipy13-delivery-probe.ts` drives
the service and the registered tool).

What is NOT reached: `KernelService.drainUnattributed` has **zero callers in the
repository** — the only occurrences are its own definition, its compiled `lib/`
copy, and two qualification JSON dumps that list it as a *surface* rather than
something invoked. Measured consequence, through the service and the tool:

```
turn1_text_mentions_late_marker = false
turn2_text_mentions_late_marker = false
drainUnattributed_count         = 1     <- classified, and buffered
verdict = NOT DELIVERED
```

The tool's own model-facing description (`ipython-tool.ts:183`) promises the
model: *"It is reported separately as unattributed output."* Nothing delivers it.
This is recorded as an ADJACENT FINDING (commit `85f9de7`) rather than fixed,
because `ipython-tool.ts` is outside this slice's owned files. **The oracle's
clause 2 is satisfied at the classification layer; a model reading a later cell's
result no longer sees the straddling write. It does not follow that the model
ever sees it at all.**
