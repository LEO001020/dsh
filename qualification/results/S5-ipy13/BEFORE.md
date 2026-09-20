# IPY-13 — BEFORE state, archived before the behaviour changed

**Date:** 2026-09-20
**Tree measured:** `D:\DSH\work\wt-s5` @ branch `wt/s5`, working tree at
`fef7612` plus the probe below (no production file modified).
**Identity:** the REAL `KernelHost` -> `broker.py` -> `jupyter_client` ->
`ipykernel` path of THIS package, with Python 3.14.3. Not a bare
`KernelManager` experiment (that is `R8-ipy13-experiment/`).

## The oracle, verbatim

> "A background thread writes to stdout after the cell has returned; then start
> another cell while the thread is still writing."

## What was run

`packages/dsh-ipython/src/s5-ipy13-before.ts` — three arms against a live kernel:

| arm | stimulus | purpose |
|---|---|---|
| 1 | cell A starts a daemon thread that prints 0.7 s later; **no** later cell | the decidable half: is the post-return write already classified late? |
| 2 | cell A starts the thread; cell B runs while it is still writing | **THE DEFECT**: where does the straddling write land? |
| 3 | ordinary `print` inside a cell | control: ordinary in-cell output must stay in the cell |

## Measured result (`before.json`)

```
arm1_late        = [{"cellId":"..._49076_3","text":"S5-BEFORE-POSTRETURN\n","epoch":1}]
arm2_cellB_stdout= "arm2-tick 0\narm2-tick 1\narm2-tick 2\nS5-BEFORE-STRADDLER\narm2-tick 3\narm2-tick 4\narm2-cellB-settled\n"
arm2_late        = []
arm3_stdout      = "S5-BEFORE-CONTROL\n"
```

**Verdict:** `DEFECT_REPRODUCED`. The write made by a thread created in cell A
arrives interleaved into cell B's `stdout` and is reported as cell B's own
output. It is absent from the late channel entirely (`arm2_late == []`). Arm 1
shows the broker's existing late classifier works for the *post-return, no
successor* case; arm 2 shows it is blind to the *straddling* case the oracle
names.

## Why (established from source, see the mechanism finding)

`broker.py:518` reads `parent_header.msg_id` off each IOPub frame and
`broker.py:525` routes it to the live sink when it matches and the cell has not
gone idle. The straddling frame **carries cell B's parent id** — ipykernel
stamps the live parent at write time — so the broker's test is satisfied and the
frame is absorbed as B's own. The distinction was destroyed inside the kernel
before the frame was sent; no frame-level check can recover it.

## Reproduce

```sh
cd packages/dsh-ipython
node --experimental-strip-types src/s5-ipy13-before.ts
```
Writes `qualification/results/S5-ipy13/before.json` (override with
`S5_BEFORE_OUT`).

## Probes kept alongside (run against a bare `KernelManager`, no DSH)

- `s5-ipy13-mechanism-probe.py` / `mechanism-probe.json` — is
  `--IPKernelApp.exec_files=` accepted, does `execute_request.metadata` reach
  `pre_run_cell`, and does a sentinel parent header survive to a real frame?
- `s5-ipy13-bootstrap-probe.py` / `bootstrap-probe.json` — the cost of the
  candidate designs (P2: a cell that joins a thread must keep its own output;
  P7: raw fd writes; P8: background `display()`).
