# P9 — G-SEAM-78: late-output DELIVERY

`SLICE: P1.2 — IPY-13's classification is wired; its DELIVERY is not. Finish it (G-SEAM-78).`

Worktree `D:\DSH\work\wt-p9`, branch `wt/p9`. HEAD measured at `2e1b2c2`
(`2e1b2c2d3657407ce7ac621b07b3307d3edd8df4`), the published default branch.

---

## 1. BEFORE — the defect, re-measured in this worktree

| measurement | command | result |
|---|---|---|
| `drainUnattributed` callers | `grep -rn drainUnattributed packages/ --include=*.ts` | definition `kernel-plugin.ts:760` + probe `s5-ipy13-delivery-probe.ts:103`. **No production caller.** |
| the promise | read `ipython-tool.ts:182-183` | `'  It is reported separately as unattributed output.'` |
| the archived measurement | `qualification/results/S5-ipy13/delivery-probe.json` | `"drainUnattributed_count": 1` while `turn1_text_mentions_late_marker` and `turn2_text_mentions_late_marker` are both `false`; `"verdict": "NOT DELIVERED"` |

So the record existed and was correctly attributed, and no model-facing text
carried it. The classification half was real; the delivery half was absent.

## 2. THE SEAM — existing, not invented

**`ToolRunContext.deferContext(UserMessage)`.** V5 §10 requires preferring an
existing context-injection seam and forbids a new Session database. Every link
below was read in the pinned checkout `D:\DSH\src\dsh-src`:

| # | link | file:line |
|---|---|---|
| 1 | declared public | `packages/core/tools/src/index.ts:408` |
| 2 | pushes onto a per-execution array | `packages/core/tools/src/index.ts:1398-1400` |
| 3 | array keyed by the execution object | `packages/core/tools/src/index.ts:1424` |
| 4 | folded into the result as `additionalContexts` | `packages/core/tools/src/index.ts:1590-1598` |
| 5 | agent loop commits result contexts in model order | `packages/core/agent-loop/src/tool-calls.ts:157` |
| 6 | spliced into the next-step inbox | `packages/core/agent-loop/src/agent.ts:491` |
| 7 | consumed at the next step boundary (durable Session projection) | `packages/core/agent-loop/src/agent.ts:316-321`; `inbox.ts:22-23,110` |

The tool already forwarded this seam before my change (`ipython-tool.ts:232`,
`onContext: context => { exec.deferContext(...) }`); only the late-output producer
was missing.

**Three properties follow from the chain, not from a check I wrote:**

1. **It does not wake the model.** The message lands in the inbox of a step that is
   already running. A thread printing at 03:00 starts no turn. (V5 §10 rule 1.)
2. **It cannot be merged into the next cell's stdout.** `additionalContexts` is a
   different field from the tool's rendered `text`; no code path puts these bytes
   there. (V5 §10 rule 2.)
3. **It is Session-scoped and durable without a new store.** The inbox is a
   Session projection.

## 3. AFTER — the same measurement, re-taken

`qualification/results/P9-late/after-probe.json` (probe source:
`packages/dsh-ipython/src/p9-late-after-probe.ts`), S5's exact stimulus:

```
turn3_text_mentions_late_marker: false
turn3_context_mentions_late_marker: true
verdict: "DELIVERED SEPARATELY: the notice reached the model-visible boundary and the cell stdout excluded it"
```

Turn 3's rendered text (the cell's stdout projection) is:

```
outcome: ok
kernel epoch: 1
--- stdout ---
turn3-settled
```

and turn 3's `additionalContexts[0]` is:

```
Runtime notice: background output from earlier cell(s)

This text was NOT produced by the cell you just ran. It was written by a background thread
after its own cell had already settled, and it is reported here rather than inside a cell
result so it cannot be mistaken for output of code that did not produce it.

records: 1, kept bytes: 21

--- late output ---
kernel epoch: 1
stream: stdout
origin cell: 73e3130a-ba735fb03fe8152eb4b3315a_44636_3
DELIVERY-LATE-MARKER
```

That is V5 §10's required presentation, with causal truth rather than aesthetics:
the origin cell is named, and the notice is its own message.

`drainUnattributed` still reports the same single record with `stream: "stdout"`
now carried, so the classification half is unchanged.

## 4. WHAT CHANGED, BY FILE

| file | what |
|---|---|
| `packages/dsh-ipython/src/late-notice.ts` | **NEW.** `LateNotice` (V5 §10's fields), `LateCausalClass`, `classifyOrigin`, `LateNoticeQueue` with three bounds. |
| `packages/dsh-ipython/src/kernel-plugin.ts` | `Entry.lateNotices`; queue construction in `entryFor`; the `onLateOutput` callback feeds both readers; `drainLateNotices`; `lateNoticeAccount`; `KernelServiceConfig.lateNoticeBounds`. |
| `packages/dsh-ipython/src/ipython-tool.ts` | `renderLateNotices`; `deliverLateNotices`; both `execute` arms call it; the description now states what the product does. |
| `packages/dsh-ipython/src/protocol.ts` | `LateStreamName`; ADDITIVE `stream?` on `LateOutput`; `BrokerEvent.late_output.stream`; the parse arm. |
| `packages/dsh-ipython/src/kernel.ts` | `onMessage` carries `stream` into the late entry. |
| `packages/dsh-ipython/src/broker.py` | `_route_iopub` emits the frame's own `stream` name. |

## 5. THE THREE BOUNDS, AND WHY THREE

V5 §10 says "bounded". One bound is not enough, and each of these closes a
different way a flood escapes:

| bound | default | what it stops |
|---|---|---|
| `records` | 32 | a flood of MANY small writes |
| `totalBytes` | 65536 | a flood that stays under the record count |
| `textBytes` (per record) | 4096 | ONE huge write consuming the whole budget |
| `spillBytes` | 262144 | moving the unboundedness from memory to disk |

Past the spill bound the bytes are **counted and dropped** — the rule RES-02
already enforces for cell output — and the drop count is rendered into the notice
text, so a reader learns bytes were lost rather than reading a prefix as the
whole.

## 6. MUTATION RECORD — the gate can fail

Each mutation was injected into production, the gate run, then restored. Both
were verified byte-clean afterwards (`git status --porcelain` showed only the
untracked `.writer-provision.json`).

| mutation | what it broke | result |
|---|---|---|
| **M1** — delete both `deliverLateNotices(...)` calls from `ipython-tool.ts` | the delivery | **3 failed / 7 passed.** Killed: the A/B/C arm, the raw-`_thread` arm, the flood arm. |
| **M2** — `classifyOrigin` returns `'known-late'` unconditionally | the invariant | **3 failed / 7 passed.** Killed: the `classifyOrigin` unit arm, the record-shape arm, the raw-`_thread` arm. |

A gate that survives both is not measuring the wiring. These are the runs that
show it does not.

**One honest note.** The epoch/restart arm failed once on the FIRST full-file run
(`BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds`) and passed
in isolation immediately after, then passed on the next two full-file runs. That
is the load-sensitivity the brief documents for restart arms, not a defect this
slice introduced — but it is recorded rather than smoothed over, because "one
rerun green ⇒ flaky case is stable" is on V5's never-infer list.

## 7. V5 §10's REQUIRED TESTS — where each one is

| required case | arm |
|---|---|
| A starts thread, A settles, B runs, A thread prints: B stdout excludes it | `A starts a thread, A settles, B runs...` |
| notice eventually visible to model separately | same arm: `contextsOf(c.result)` contains the notice while `c.text` does not |
| raw `_thread` origin undecidable | `a raw _thread origin is reported UNDECIDABLE, and no cell is named` |
| late flood bounded/spilled | `a late FLOOD is bounded and spilled through the real product path` |
| notices Session-scoped | `notices are SESSION-scoped: another Session cannot drain them` |
| restart/epoch included | `the record carries the kernel EPOCH, and a restart cannot deliver across generations` |

## 8. WHAT IS *NOT* CLAIMED

- **No model turn was driven.** A notice reaching `additionalContexts` proves the
  product delivers it to the boundary the agent loop consumes
  (`tool-calls.ts:157` → `agent.ts:491`). It does NOT prove a model read it or
  acted on it. No live provider is authorized this round.
- **The `daily` profile was not booted.** Every arm mounts the real registry and
  the real `KernelService` and drives the tool through `ctx.tools.execute`, which
  is the loop's own call shape — but composition-tier reachability is measured by
  other slices' runners, not here.
- **`drainUnattributed` is retained, not deleted.** The delivery path is
  `drainLateNotices`; the old accessor is documented as host-only so the existing
  classification gates keep measuring what they measured.
