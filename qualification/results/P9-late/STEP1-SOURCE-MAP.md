# P9 STEP 1 — SOURCE MAP (G-SEAM-78, late/background output DELIVERY)

Measured on worktree `D:\DSH\work\wt-p9`, branch `wt/p9`, HEAD `2e1b2c2`.
Every claim below is a line I read in this tree, not a recollection.

---

## 1. The defect: `drainUnattributed` has no production caller

| item | measured |
|---|---|
| definition | `packages/dsh-ipython/src/kernel-plugin.ts:760` |
| shape | `drainUnattributed(agent: Agent): UnattributedOutput[]` |
| body | `entry.unattributed.splice(0, entry.unattributed.length)` — drains the per-`Entry` array |
| buffer created at | `kernel-plugin.ts:512` (`const unattributed: UnattributedOutput[] = []`), filled at `:525` (`onLateOutput: output => { unattributed.push(output) }`), stored on the Entry at `:544` |
| record type | `kernel-plugin.ts:239` — `interface UnattributedOutput extends LateOutput { readonly epoch: number }`; `LateOutput` is `protocol.ts:203` = `{ cellId, text }` |

Callers, repo-wide, excluding `lib/` (generated):

```
packages/dsh-ipython/src/kernel-plugin.ts:760   <- the definition
packages/dsh-ipython/src/s5-ipy13-delivery-probe.ts:103  <- a probe, not production
```

`packages/dsh-ipython/lib/kernel-plugin.d.ts:430` is the emitted declaration, not a caller.
**CONFIRMED: zero production callers.** G-SEAM-78's claim holds at this HEAD.

The S5 probe's own archived verdict (`qualification/results/S5-ipy13/delivery-probe.json`):

```json
"drainUnattributed_count": 1,
"verdict": "NOT DELIVERED: the late output was classified and then reached no model-facing text"
```

So the record EXISTED (1 entry, `cellId` = a real cell msg_id, `epoch` 1) while both
model-facing texts contained no trace of it.

## 2. What the tool promises today

`packages/dsh-ipython/src/ipython-tool.ts:182-183`, inside the `description` array:

```
'- Output written by a background thread after the cell returns is NOT part of the result.',
'  It is reported separately as unattributed output.',
```

The return path is `execute(args, exec)` at `:207-254`: it calls
`service.runCell(exec.agent, args.code, exec.signal, authority)` (`:237`) and returns
`{ outcome, epoch, isError, text: renderCell(result, epoch) }` (`:239-244`).
`renderCell` (`:71-138`) renders ONLY `CellResult` fields. Nothing in either function
touches `drainUnattributed`, `unattributed`, or the late-output path.
**The promise is unkept in the same file that makes it.**

## 3. THE SEAM I CHOSE (the load-bearing decision of this slice)

**`ToolRunContext.deferContext(UserMessage)` — the existing DSH deferred-context
seam. No new Session database, no new event type, no new queue outside the kernel Entry.**

The full chain, each link read in the pinned checkout (`D:\DSH\src\dsh-src`):

| # | link | file:line |
|---|---|---|
| 1 | `ToolRunContext.deferContext` is declared public on the runtime context | `packages/core/tools/src/index.ts:408` |
| 2 | its implementation pushes onto a per-execution array | `packages/core/tools/src/index.ts:1398-1400` |
| 3 | that array is keyed by the execution object | `packages/core/tools/src/index.ts:1424` |
| 4 | the dispatch stage folds it into the result | `packages/core/tools/src/index.ts:1587-1598` → `additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]` |
| 5 | the agent loop commits result contexts in model order | `packages/core/agent-loop/src/tool-calls.ts:157` — `for (const context of result.additionalContexts ?? []) acceptContext(context)` |
| 6 | the acceptor splices them into the **next-step inbox** | `packages/core/agent-loop/src/agent.ts:489-491` — `context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context])` |
| 7 | the loop consumes `next-step` at the step boundary, and it is a DURABLE projection | `packages/core/agent-loop/src/agent.ts:316-321`; `packages/core/agent-loop/src/inbox.ts:22-23,110` |

Why this seam and not another:

- **It is the project's own idiom for exactly this**, already used by
  `packages/dsh-daily-work/src/programmatic-scope.ts:589` and `:618` to ferry nested
  context out of a tool, and by `packages/core/tools/src/ptc.ts:633,639`.
- **The tool already forwards it.** `ipython-tool.ts:232` builds
  `onContext: context => { exec.deferContext(...) }` and `:233`
  `onConcludeTurn`. The ferrying code is present; only the late-output producer is missing.
- **It does not wake the model.** `next-step` is consumed at a step boundary that is
  already happening; splicing a message does not start a turn. Rule 1 of the slice holds
  by construction rather than by a check.
- **It is separate from the cell's stdout by construction.** `additionalContexts` is a
  different field from the tool's rendered `text`, so rule 2 ("never merge into the next
  cell's stdout") cannot be violated by a rendering mistake.
- **It is durable and Session-scoped without a new database.** The inbox is a Session
  projection, so the notice inherits Session scoping from DSH rather than from a store
  I would have to invent.

Rejected alternatives, with the reason:
- a new Session event type — forbidden by round-1 brief §5.14 (no `ignorable` for an
  out-of-repo event at this pin);
- a second storage-domain ledger — a second store for a fact that needs no durability
  beyond the turn boundary;
- appending to the next cell's result text — the exact defect IPY-13 exists to prevent.

## 4. Classification vocabulary — reused, not re-invented

`packages/dsh-daily-work/src/kernel-lifecycle.ts:120`:
```ts
export type OutputClass = 'cell' | 'late' | 'unattributed' | 'foreign'
```
`:112` states the rule: *"we do not know where it came from, and guessing would attach it
to whichever cell happens to be running."* `:454` — *"Attribute a frame to a class. Never
merges late/unattributed into the cell."*

That taxonomy classifies **one frame at the transport**. V5 §10's record classifies
**one record at delivery**. They are different axes, and `dsh-ipython` must not import
`dsh-daily-work` (no such dependency exists in either direction — checked). So the notice
record names its own two-value axis `known-late | undecidable`, which is V5 §10's own
vocabulary, and the mapping is documented in the module so a reader cannot mistake one
for the other:

| `OutputClass` (frame, transport) | `LateCausalClass` (record, delivery) |
|---|---|
| `'late'` — origin cell known | `'known-late'` |
| `'unattributed'` — no discoverable origin | `'undecidable'` |

## 5. Origin classification (S5's work — PRESERVED, not touched)

`packages/dsh-ipython/src/broker.py`, block above `DSH_BACKGROUND_ORIGIN` (`:107`):
- `:112` `attribution_bootstrap_source()` generates the kernel-side bootstrap;
- `:126` the template records `_cell_parent`, carries it into threads a cell starts
  (`_thread_start`, `:220-237`), and stamps a write with the origin it HAS or with the
  sentinel when it has none (`:185`);
- `:664-667` injected via `KernelManager.start_kernel(extra_arguments=)` →
  `--IPKernelApp.exec_files=`;
- `:726-727` the marker file is read back, so "did the bootstrap load" is measured;
- `:828` `self._event("late_output", cellId=parent or "", text=text)` — the router turns
  any frame that is not the live cell's own into a late event.

`DSH_BACKGROUND_ORIGIN = 'dsh:background'` (`broker.py:107`, mirrored at `protocol.ts:222`)
is the sentinel; a raw `_thread.start_new_thread` write is stamped with it and is therefore
`undecidable` rather than attributed.

## 6. The invariant I must not break

> **Unknown origin is NEVER attached to a later cell.**

Two ways to break it, both to be tested as negative arms:
1. attributing an origin-less record to whichever cell runs next;
2. merging a late record into the next cell's stdout.

## 7. Regions I will change, and who else owns what

`packages/dsh-ipython/src/kernel-plugin.ts` has five writers this round.

| writer | region |
|---|---|
| P8 | `runCell` / preamble / `canPrependPreamble` |
| **P9 (me)** | `drainUnattributed` and the late-output notice path |
| P10 | the ledger-open call site |
| P11 | `defaultEnvironmentDigest` / status surface |
| P12 | `kernelRoot()` / `DEFAULT_KERNEL_ROOT` |

My planned edits, named for a mechanical merge:
- `kernel-plugin.ts` — the `Entry.unattributed` field and its initialisation (`:313`,
  `:512`, `:525`, `:544`), and `drainUnattributed` (`:760-764`). No edit inside `runCell`.
- `packages/dsh-ipython/src/ipython-tool.ts` — the description promise (`:182-183`) and
  the `execute` return path (`:237-244`).
- `packages/dsh-ipython/src/protocol.ts` — an ADDITIVE optional `stream` field on
  `LateOutput` (`:203-207`) and its parse arm (`:358-366`).
- new: `packages/dsh-ipython/src/late-notice.ts`, new test file,
  `qualification/results/P9-late/`.
