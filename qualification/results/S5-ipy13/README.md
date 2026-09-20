# S5 — IPY-13 evidence

**Slice:** IPY-13 — late output is classified separately and never rides another cell.
**Tree:** `D:\DSH\work\wt-s5` @ `wt/s5`. **Read `BEFORE.md`, `MECHANISM.md`,
`AFTER.md` in that order** — they are the record; the JSON/py files are its raw
material.

## Read this first: the frozen archive

`before.json` is the PRE-FIX measurement. **Do not regenerate it.** Re-running
`s5-ipy13-before.ts` used to overwrite it with post-fix behaviour — a re-run
destroying the evidence it exists to preserve. The instrument now defaults to
`before-rerun.json`; writing to `before.json` requires `S5_BEFORE_OUT` naming it
explicitly. The archive was restored with `git checkout` after this was caught.

## The before/after pair, one instrument

Both are `s5-ipy13-before.ts` against this tree's real `KernelHost` -> `broker.py`
-> kernel. Same stimulus, same arms; only the tree differs.

| file | tree | `arm2_cellB_contains_straddler` | `arm2_late` |
|---|---|---|---|
| `before.json` | pre-fix | `true` | `[]` |
| `after.json` | post-fix | `false` | 1 entry, the straddler |

## Files

| file | what it is |
|---|---|
| `BEFORE.md` | the defect, archived before the behaviour changed |
| `MECHANISM.md` | how attribution works, at file:line, and the gate that is decidable |
| `AFTER.md` | the fix, the gates, the mutation table (incl. what did NOT go red), product reachability |
| `before.json` / `after.json` | the frozen pair above |
| `s5-ipy13-gate-probe.py` + `.json` | WHICH signal can tell a cell's write from a thread's. The decisive measurement: the cell's own writes take ipykernel's ContextVar; every out-of-thread write does not |
| `s5-ipy13-after-probe.py` + `.json` | the bootstrap in a bare kernel: the straddler, plus the thread+join control |
| `s5-ipy13-negative-probe.py` + `.json` | the bootstrap prevented from loading: the report CAN be false and the defect returns |
| `s5-ipy13-traps-probe.py` + `.json` | 12 semantic traps (await, magic, traceback, displayhook, subprocess, asyncio, logging, grandchild thread, ...) |
| `s5-ipy13-restart-probe.py` + `.json` | the bootstrap survives a restart, and the stale-marker hazard |
| `s5-ipy13-mechanism-probe.py` + `.json` | `exec_files` / `execute_request.metadata` / sentinel-parent reachability |
| `s5-ipy13-bootstrap-probe.py` + `.json` | the cost of the candidate designs (P2 thread+join, P7 raw fd, P8 background display) |
| `delivery-probe.json` | the ADJACENT FINDING: classified, then delivered to nobody |

## The scripts under `packages/dsh-ipython/src/`

- `s5-ipy13-before.ts` — the instrument above (both rows of the table).
- `s5-ipy13.test.ts` — the fix's gate: straddler undecidable, thread+join control,
  grandchild, raw `_thread`, restart arm.
- `s5-ipy13-delivery-probe.ts` — drives the SERVICE and the registered tool and
  asks what the model-facing text contains.
