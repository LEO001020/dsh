# T6 — the IPython kernel lifetime and ownership gates

**Date:** 2026-09-20
**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`
**Package under test:** `packages/dsh-ipython`
**Test files:** `packages/dsh-ipython/src/lifecycle.test.ts` (15 tests),
`packages/dsh-ipython/src/faults.test.ts` (11 tests)

**Revision note.** This run was re-dispatched after an infrastructure failure
("Model request failed" — an API outage, not a test failure). The tests themselves
survived on disk and are committed at `80cf8e0`; this run changed them in exactly
three ways, all additive:

1. `console.log('[T6-MEASURED] …')` lines that print values already being asserted,
   so the numbers below are the run's own output rather than numbers copied out of
   a code comment;
2. a `try`/`catch` around the restart call that logs the broker's own
   `kernel.out`/`kernel.err` on failure and then **rethrows the same error**, so the
   test's pass/fail outcome is unchanged;
3. one added import (`readFile`) for that diagnostic.

No assertion was weakened, no threshold moved, no test was skipped, deleted or
renamed. The flake reported in §5 was reproduced on the **pristine committed
version** as a control (§5), so it is not caused by these edits.

**Source digests at the time of the runs** (`sha256`, captured 2026-09-20T07:54+08:00):

| File | sha256 |
|---|---|
| `packages/dsh-ipython/src/lifecycle.test.ts` | `3691a3671dd66c4a4406f4c6717c55017c6ba3e86e06ba753e492a9c679a9935` |
| `packages/dsh-ipython/src/faults.test.ts` | `37095ac672a69a0f0cde2084a9826fc80c58edf47361bb311da29e5b9486f3c2` |
| `packages/dsh-ipython/src/kernel.ts` | `60a444bd27eefec859daaa8032905ab7802492b5c7e5a04e88270d489927d09f` |
| `packages/dsh-ipython/src/kernel-plugin.ts` | `436c140fa55174ebcbea90163b0f44696effba8e92ece8817da07acc5d642bae` |
| `packages/dsh-ipython/src/broker.py` | `a4d5319404409dae560dbcf2afbeaa38043eb90d96349a7914e94629578e86a9` |

**Commands**

```sh
cd /d/DSH/work/dsh-native-daily/packages/dsh-ipython

# one file at a time, single worker (mandatory CPU discipline)
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/lifecycle.test.ts \
  --maxWorkers=1 --no-file-parallelism
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/faults.test.ts \
  --maxWorkers=1 --no-file-parallelism

# one gate in isolation (used for the flake analysis in §5)
node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/faults.test.ts \
  -t "restart advances the epoch" --maxWorkers=1 --no-file-parallelism

# the typecheck baseline (must stay exit 0)
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json --noEmit
```

**Measured result**

| File | Tests | Result | Raw output |
|---|---|---|---|
| `lifecycle.test.ts` | 15 | **15 passed / 15** | `tests-lifecycle-full.txt` |
| `faults.test.ts` | 11 | **10 passed / 1 failed** — the single failure is the order-dependent restart flake in §5, reproduced on the pristine HEAD as a control. One run of the same file was **11 passed / 11** (`tests-faults-full-green-run.txt`), which is why §5 calls it flaky rather than deterministic | `tests-faults-full.txt` |
| `faults.test.ts -t "restart advances the epoch"` | 1 | **1 passed**, 5.17 s | `tests-faults-restart-isolated.txt` |
| `faults.test.ts` at pristine `80cf8e0` (control) | 11 | **10 passed / 1 failed** — the same failure | `tests-faults-pristine-head-control.txt` |
| `faults.test.ts -t "under the cap\|restart advances"` | 2 | **1 passed / 1 failed** — the minimal reproducing pair | `tests-faults-undercap-then-restart-FAIL.txt` |
| `tsc -p tsconfig.check.json --noEmit` | — | **exit 0** | `tsc-check.txt` |

**Commit provenance.** The two test files and the first capture of this slice's
evidence were committed by the root agent's deliberate checkpoint commit
`ec464e2` ("commit the accumulated evidence from waves 1 and 2: 242 files"), which
swept nine agents' uncommitted work into one commit on purpose, with the reason
stated in its message (an uncommitted change in a shared tree is what lost an
earlier filing). This run's own commit carries the refresh of
`tests-lifecycle-full.txt` from the final verification run. Verified: the
committed bytes of both test files are byte-identical to the disk copies.

---

## 1. Gate table

Every verdict below is `[measured]` in this run unless the row says otherwise.

| Gate | What it asserts | Exact command | Measured result | Verdict |
|---|---|---|---|---|
| **IPY-04** | A Session owns kernel identity, not the Agent activation: two distinct Agent objects on one Session reach the **same kernel PROCESS**, and two Sessions reach different ones | `vitest run src/lifecycle.test.ts -t "two Agent objects on one Session"` | 1 kernel pid after activation 1; **identical pid set** after activation 2; 2 distinct kernels for 2 Sessions; first kernel still alive after the second starts; `listSessions()` = `['session-other','session-owner']` | **PASS** |
| **IPY-05a** | An activation ending does **not** destroy a reusable kernel | `vitest run src/lifecycle.test.ts -t "ending an activation leaves the kernel alive"` | kernel pid set unchanged, `hasKernel` true, epoch unchanged, pre-end namespace intact (`after activation end: kept`), no epoch advance | **PASS** |
| **IPY-05b** | `evict` is the explicit, host-only way to end a kernel | `vitest run src/lifecycle.test.ts -t "evict is the explicit way"` | `evict` → `true`; `hasKernel` → `false`; owned kernel count → 0 within 15 s | **PASS** |
| **IPY-07a** | A cell that overruns its budget is **classified**, and its state loss is **stated** (not a false success) | `vitest run src/faults.test.ts -t "a timeout reports unknown"` | `KernelOutcomeUnknownError`, `outcome: 'unknown'`, `volatileStateLost: true`, epoch advanced, reason names `6000 ms`, elapsed 11.2 s (< 60 s bound), pid replaced, pre-timeout variable gone | **PASS** |
| **IPY-07b** | The replacement kernel after a timeout is genuinely usable | `vitest run src/faults.test.ts -t "replacement kernel after a timeout"` | `replacement usable: 42` | **PASS** |
| **IPY-07c** | `restart()` advances the epoch, replaces the process, loses the namespace, and **preserves the cwd** | `vitest run src/faults.test.ts -t "restart advances the epoch"` | isolated: **PASS in 5.17 s**, `epoch 1→2`, pid `37912→30204`, `alive: true`, `kernelCwdEnforced: true`, `kernelCwd` == the Session's project dir. Whole-file: **FAIL**, see §5 | **PASS in isolation / FAIL in the full-file run — see §5** |
| **IPY-09a** | stdout order and display order are each preserved, and are **separate sequences** | `vitest run src/lifecycle.test.ts -t "stdout order and display order"` | `RAW-ONE` before `RAW-TWO`; display `[0]=RICH-ONE`, `[1]=RICH-TWO`; neither rich payload appears in stdout and no raw text appears in display | **PASS** |
| **IPY-09b** | stderr is its own ordered sequence, separate from stdout | `vitest run src/lifecycle.test.ts -t "stderr is its own ordered sequence"` | `OUT-A`<`OUT-B`, `ERR-A`<`ERR-B`; stdout contains no `ERR-A`, stderr contains no `OUT-A` | **PASS** |
| **IPY-10a** | No lifecycle surface is reachable from inside a cell; the cap and timeout are not cell state | `vitest run src/lifecycle.test.ts -t "no lifecycle surface is reachable"` | `builtin_lifecycle_names: ["__IPYTHON__","get_ipython"]`, `has_ctx: false`, `has_kernel_service: false`, `has_ipython_service: false`, `lifecycle_callables: []`, `control_env: "pipe"`, `cap_or_timeout_symbols: []` | **PASS** (the negative is the finding — §3) |
| **IPY-10b** | A cell that shuts down its own kernel is reported as a **NEW generation** with the loss stated | `vitest run src/lifecycle.test.ts -t "shuts down its own kernel"` | generation defined, `volatileStateLost: true`, `epoch > epochBefore`; if it threw, `outcome: 'unknown'`; if it returned, the state is demonstrably gone | **PASS** |
| **IPY-12a** | No automatic cell replay: a cell that kills its own kernel is not re-run in the replacement | `vitest run src/lifecycle.test.ts -t "not re-run in the replacement"` | marker file reads exactly `ran\n` after the kill **and** after a further cell; `KernelOutcomeUnknownError` with `outcome: 'unknown'`, `volatileStateLost: true` | **PASS** |
| **IPY-12b** | The output cap bounds the cell projection, and a direct fd-1 write is a **measured boundary** | `vitest run src/faults.test.ts -t "written through the cell's own fd 1"` | cap `4096`; cell reports `totalBytes: 10`, `truncated: false`, no spill; `kernel.out` grows **exactly 5,000,000** | **PASS (boundary pinned — §4)** |
| **IPY-13a** | The classifier has teeth in both directions | `vitest run src/lifecycle.test.ts -t "the classifier has teeth"` | `[]` before start; exactly 1 broker + 1 kernel after start; the kernel pid the broker reports is in the ancestry walk; `[]` after shutdown | **PASS** |
| **IPY-13b** | The broker is owned by the DSH subprocess seam, not a bare spawn | `vitest run src/lifecycle.test.ts -t "runs under the subprocess-local runner"` | ancestry above the broker contains `subprocess-local` `runner.js`; the kernel's nearest `broker.py` ancestor **is** that broker pid; `[]` after shutdown | **PASS** |
| **IPY-14** | Host-side loss is reconciled, and crash orphans are observed | `vitest run src/lifecycle.test.ts -t "a broker killed out from under the host"` | `unexpectedExit: "broker exited with code 1 signal null"`; `kernelSurvivedBroker: false`; shutdown leaves nothing of ours | **PASS (observed — §6)** |
| **IPY-15a** | The kernel's `os.getcwd()` is the Session header cwd, **per Session** | `vitest run src/lifecycle.test.ts -t "os.getcwd() inside the kernel"` | both Sessions match their own requested root; `kernelCwdEnforced: true`; relative write lands in the project root | **PASS (§2 — this is the retraction-relevant gate)** |
| **IPY-15b** | A Session with no declared cwd falls back to the host root, never an arbitrary directory | `vitest run src/lifecycle.test.ts -t "no declared cwd falls back"` | reported cwd starts with the configured host root | **PASS** |
| **IPY-15c** | The kernel cwd and the scratch dir are **separate**, and each holds what it should | `vitest run src/lifecycle.test.ts -t "cwd and the scratch dir are SEPARATE"` | `cwdEqualsSessionRoot: true`, `dirEqualsScratch: true`, `spillEqualsScratch: true`, `scratchDiffersFromCwd: true`; `kernel.out` in scratch, **not** in the project; relative write lands in the project, not scratch | **PASS (§2)** |
| **IPY-15d** | The scratch dir is created per Session and its log is bounded | `vitest run src/lifecycle.test.ts -t "scratch dir is created for a Session"` | `kernel.out` + `kernel.err` exist per Session; a second Session gets its own dir; log < 1 MB; the dir **survives** shutdown (the package does not delete it — asserted as the honest state) | **PASS** |

---

## 2. IPY-15 is PASS, not a fixed FAIL — and the scratch/cwd separation is its strongest form

`[measured]` **The kernel's working directory is the Session's project root.** The
gate asserts `os.getcwd()` *inside the kernel*, because the host's own idea of the
directory is not the thing that makes a model's relative path resolve correctly.

The link-by-link agreement, from this run:

```
[T6-MEASURED] IPY-15-kernel-cwd {"kernelCwdReportedByCell":"c:/users/hzq00/appdata/local/temp/t6-project-a-w1pc1s",
 "sessionCwdRequested":"c:/users/hzq00/appdata/local/temp/t6-project-a-w1pc1s",
 "secondSessionCwd":"c:/users/hzq00/appdata/local/temp/t6-project-b-dkpvzb",
 "secondSessionRequested":"c:/users/hzq00/appdata/local/temp/t6-project-b-dkpvzb"}
```

Two different Sessions in one service each got **their own** root, which is what
makes this a per-Session claim rather than a single-kernel coincidence.

**Why this gate is the correct record and G-SEAM-29 is not.** The root agent's
earlier measurement (`G-SEAM-29`) claimed the cwd was the scratch dir. That was a
**stale-`lib/` artifact**: every home on this machine installs `dsh-ipython`
through a `link:`, so a probe that boots an *installed* profile executes the built
`lib/`, and at 05:20 that build predated the fix. It has been **RETRACTED** in
`docs/GAPS.md`. The re-measured chain in
`qualification/results/ROOT-verification/kernel-cwd-chain.json` and
`kernel-cwd-rerun.json` agrees with this gate: `agentSessionCwd` =
`D:/DSH/work/dsh-native-daily`, `ENV_KERNEL_CWD` = the same, and the kernel's own
`os.getcwd()` = `D:\DSH\work\dsh-native-daily`. The independent confirmation is
the marker file: the 05:20 copy sits in
`.ipython-kernels/session-d6432773-…/`, the 06:48 copy sits at the project root.

### The separation gate is a real check, not a restatement

`[measured]` The kernel cwd being the Session root does **not** imply the scratch
directory is working, and vice versa — they are **two different environment
variables set from two different fields of the same options object**
(`kernel.ts:228-229` set `DSH_IPYTHON_SPILL_DIR` and `DSH_IPYTHON_KERNEL_DIR`
from `workingDirectory`; `kernel.ts:235` sets `DSH_IPYTHON_KERNEL_CWD` from
`kernelWorkingDirectory ?? workingDirectory`). An implementation that set all
three to one value would satisfy either half alone while destroying the property
that matters.

`kernel.ts:70-80` documents the separation as deliberate, in the product's own
words: *"They answer two different questions and conflating them caused a real
defect. `workingDirectory` is where the broker runs and where spill and kernel-log
files are written — a host-owned scratch directory. This field is the directory a
cell's RELATIVE PATHS resolve against, which must be the Session's project root,
because a kernel rooted in a scratch directory makes every relative path in
model-written Python silently wrong."*

The gate therefore measures **four** facts from inside the kernel plus two from the
host side:

```
[T6-MEASURED] IPY-15-cwd-vs-scratch {"kernelOsGetcwd":"c:/users/hzq00/appdata/local/temp/t6-cwd-scratch-luvcli",
 "kernelEnvKernelCwd":"c:/users/hzq00/appdata/local/temp/t6-cwd-scratch-luvcli",
 "kernelEnvKernelDir":"c:/users/hzq00/appdata/local/temp/dsh-ipython-lifecycle-3qiphd/session-cwd-scratch",
 "kernelEnvSpillDir":"c:/users/hzq00/appdata/local/temp/dsh-ipython-lifecycle-3qiphd/session-cwd-scratch",
 "sessionProjectRoot":"c:/users/hzq00/appdata/local/temp/t6-cwd-scratch-luvcli",
 "hostScratchDir":"c:/users/hzq00/appdata/local/temp/dsh-ipython-lifecycle-3qiphd/session-cwd-scratch",
 "cwdEqualsSessionRoot":true,"dirEqualsScratch":true,"spillEqualsScratch":true,"scratchDiffersFromCwd":true}
```

1. `cwd` == the Session's project root — what the cell sees;
2. `ENV_KERNEL_CWD` == the same root — so the agreement is not a coincidence of the
   launcher's own directory;
3. `ENV_KERNEL_DIR` and `ENV_SPILL` == the host scratch dir — host-owned files go
   to host-owned space;
4. the two are **different paths** — `scratchDiffersFromCwd: true`.

Plus the host-side consequence: `kernel.out` exists **in scratch** and does **not**
exist in the project; a relative write lands in the **project** and does **not**
appear in scratch. That last pair is what makes this a real check rather than a
restatement: a host that wrote its log into the user's project would pass a
cwd-only check and fail this one, and an implementation that rooted the kernel in
scratch would pass a scratch-only check and fail this one.

---

## 3. IPY-10 — the negative result is the finding

`[measured]` No lifecycle symbol is reachable in-cell:

```
[T6-MEASURED] IPY-10-lifecycle-surface {"builtin_lifecycle_names":["__IPYTHON__","get_ipython"],
 "has_ctx":false,"has_kernel_service":false,"has_ipython_service":false,
 "lifecycle_callables":[],"control_env":"pipe","cap_or_timeout_symbols":[]}
```

- **No host-side registry is visible**: no `ctx`, no `KernelService`, no `ipython`
  service. `dir(__builtins__)` holds only IPython's own `get_ipython` and
  `__IPYTHON__`.
- **No lifecycle callable exists**: `ipython_open`/`_close`/`_restart`/`_status`,
  `kernel_restart`/`_shutdown`/`_open` — measured `[]`.
- **The broker's control channel is not speakable from a cell**:
  `DSH_SUBPROCESS_CONTROL` is the literal string `"pipe"`, not a usable descriptor
  number, so the framing the host writes requests on cannot be reproduced in-cell.
- **The cap and the timeout have no in-cell representation**
  (`cap_or_timeout_symbols: []`), because they are host configuration passed per
  request from `kernel.ts`, not kernel state. A cell cannot widen them.

**This constraint is what keeps the model from leaking or destroying kernels**, so
the *absence* is the gate's content, not a missing assertion. Note the honest
boundary the test's own comment records: under trusted-local the cell **is** the
kernel process, so a cell can still read its own connection file and can call
`get_ipython().kernel.do_shutdown()`. That is why IPY-10b asserts the property the
host actually owns — that a self-inflicted death is **observed and reported as a
new generation with the loss stated**, never as silent continuity.

---

## 4. IPY-12's fd-1 boundary — a real silent-loss finding

`[measured]` **The cap governs the IOPub projection, not the kernel's real stdout
descriptor.**

```
[T6-MEASURED] IPY-12-fd1-boundary {"cap":4096,"reportedStdoutTotalBytes":10,
 "reportedTruncated":false,"reportedSpillPath":null,
 "kernelOutBytesBefore":0,"kernelOutBytesAfter":5000000,"kernelOutGrowth":5000000,
 "kernelOutPath":"C:/Users/hzq00/AppData/Local/Temp/dsh-ipython-fault-MVDRsZ/kernel.out"}
```

A cell writing `os.write(1, b"B" * 5_000_000)` with a **4096-byte cap**:

| Fact | Value |
|---|---|
| cap in force | **4096** |
| bytes the cell's result reports | **10** |
| `truncated` | **false** |
| spill path reported | **none** |
| `kernel.out` growth | **exactly 5,000,000** |

**The consequence, stated plainly.** 5,000,000 bytes are lost between the kernel
and the host with **no signal to the cell**. The model sees a clean, small,
untruncated result and never learns that 5 MB went somewhere it cannot read — the
broker redirected the kernel's fd 1 into `kernel.out`, and IOPub never carried
those bytes, so the cap (which is enforced on the receiving side) cannot see them.
This is not the OOM class the cap exists to prevent, because the bytes land in a
host-side file rather than in host memory; it **is** a silent-loss class, and it is
the same shape as the defect IPY-12's oracle forbids ("the model is never handed a
silent prefix").

The test asserts the **observed behaviour** rather than a guarantee, so a future
change either keeps this exact boundary or fails here and has to say why.

---

## 5. The restart result, and the near-miss that produced G-SEAM-36

### What the gate asserts, and its measured values

`[measured]` In isolation the gate is green in **5.17 s** (raw:
`tests-faults-restart-isolated.txt`) with these values:

```
[T6-MEASURED] IPY-07-restart {"epochBefore":1,"epochAfter":2,"pidBefore":37912,
 "pidAfter":30204,"alive":true,
 "kernelCwd":"C:\\Users\\hzq00\\AppData\\Local\\Temp\\t6-restart-project-249O1o",
 "kernelCwdEnforced":true,
 "sessionCwd":"C:\\Users\\hzq00\\AppData\\Local\\Temp\\t6-restart-project-249O1o"}
```

It asserts four facts that together would expose a real restart defect: **the epoch
advances** (`1→2`), **the pid is replaced** (`37912→30204`), **the kernel is alive**
(`true`), and **the cwd is preserved with `kernelCwdEnforced: true` and equal to
the Session's project directory** — a real directory that is **not** the kernel
root. Plus: the pre-restart namespace is gone and the replacement answers a new
cell (`usable after restart: 42`).

### The near-miss: how G-SEAM-36 was filed and disproved

`[read in source]` — the sequence, from the test's own comment and `docs/GAPS.md`:

1. This agent reported mid-task that `KernelService.restart()` failed with
   `RuntimeError: Kernel didn't respond in 60 seconds` when the Session cwd
   differed from the kernel root.
2. The root agent recorded it as **G-SEAM-36** with a traced-and-killed hypothesis
   about `restart_kernel` dropping the cwd.
3. This agent then **disproved it before finishing**: its first version had
   constructed a `KernelHost` **by hand** with a working directory that **did not
   exist**. The broker failed with its own `NotADirectoryError`.
4. **The SERVICE is the layer that creates that directory** —
   `mkdirSync(kernelWorkingDirectory, { recursive: true })` at
   `kernel-plugin.ts:180` (and `mkdirSync(workingDirectory, …)` at line 174) — so a
   hand-built host bypasses the creation step and fails for a reason that says
   nothing about the product.
5. The corrected test uses the **SERVICE**, which is the subject. It passes.
   `G-SEAM-36` is now **RETRACTED** in `docs/GAPS.md`.

**The lesson, stated once: before filing a defect, confirm the failing path is the
one the product takes.** This is the **second retraction in this project with
exactly that shape** — a measurement taken through a path that was not the
product's. The first (`G-SEAM-29`, §2) was a stale `lib/`; this one was a
hand-built host.

### A separate, reproducible flake — reported, not hidden

`[measured]` While re-running to capture raw output, this run found that the
restart gate **passes in isolation but fails inside the full-file run**, with
exactly the G-SEAM-36 error message — this time through the **service**, so it is
not the hand-built-host artefact:

| Configuration | Result | Elapsed |
|---|---|---|
| whole `faults.test.ts` (with this run's logging) | **5 of 6 runs FAILED** — `KernelTransportError: BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds` | 63.5–64.4 s per failure; the one pass ran 77.7 s total |
| whole `faults.test.ts` at pristine `80cf8e0` (control) | **1 of 1 FAILED** — same message | 64.4 s |
| any subset run where the restart test reached a verdict | **13 of 15 PASSED**; the 2 failures were the `under the cap` → `restart` pair (63.99 s) and one run whose diagnostic block itself threw after the restart call had already failed | 4.55–5.88 s per pass |

The control run used a byte-identical copy of the committed file
(`sha256 da03a0f4…`, verified equal to `git show 80cf8e0:…`), which proves the
failure **pre-exists this run's logging edits** and is not caused by them.

**What was established about the mechanism:**

- `[read in source]` The message is not the broker's own. It is raised by
  `jupyter_client/client.py:211` inside `wait_for_ready`, called at
  **`broker.py:839`** in the restart path (`self._kc.wait_for_ready(timeout=60)`)
  — and at `broker.py:435` on the initial-start path. So a restart that does not
  become ready within 60 s is reported by the client library, not by this package.
- `[measured]` The broker's own logs are **empty** at the moment of failure:
  `[T6-DIAG] kernel.out:` and `[T6-DIAG] kernel.err:` both printed with no content,
  so the kernel neither logged an error nor died with a traceback — it simply did
  not answer `kernel_info` in time.
- `[measured]` Failure rate observed in this run: **5 of 6** whole-file runs failed,
  and the same test passed **13 of 15** subset runs. The outcome is flaky and
  order-dependent, not deterministic.
- `[measured]` The failure is not attributable to any single preceding test: the
  pair `under the cap` → `restart` failed once (63.99 s) and then passed **4
  consecutive times** in the identical configuration, so the trigger is
  timing/load rather than test content. The pairs `requirement 8` → `restart`,
  `requirement 11` → `restart`, the 200 MB flood → `restart`, and the giant
  display payload → `restart` all passed.
- `[measured]` No kernel or broker from these runs was left orphaned (verified by
  process ancestry after each failure), so the failure does not leak processes.

**What this is and is not.** It **is** a real, reproducible-in-aggregate
flakiness in the restart path under sequential load, and it is recorded here
rather than re-run until green. It is **not** evidence that restart is broken:
the four asserted facts hold every time the call returns, and the failure is the
call not returning within the client library's fixed 60 s readiness window. It is
**not** investigated to root cause in this run — the diagnosis would need
instrumentation inside `wait_for_ready`'s retry loop, which is a separate
measurement. **Verdict: PASS in isolation, FAIL in the full-file run; the gate's
assertions are unchanged and no threshold was moved.** A reader should treat the
whole-file `faults.test.ts` result as **not green** until this is resolved.

---

## 6. IPY-14 — what actually happens to a kernel when its host-side link dies

`[measured]` The broker is killed out from under a live host, with no chance for
teardown to run. The result, observed rather than assumed:

```
[T6-MEASURED] IPY-14-crash-orphan {"brokerPid":8652,"kernelPid":23292,
 "unexpectedExitReported":"broker exited with code 1 signal null",
 "kernelSurvivedBroker":false,"kernelAliveAfterBrokerKilled":false}
```

Two facts, one asserted and one observed:

1. **The loss is reconciled** — `unexpectedExit` becomes
   `"broker exited with code 1 signal null"`, the signal a supervisor reconciles
   on. Without it the host would keep handing cells to a broker that is gone.
2. **The kernel does NOT survive its broker** on this platform —
   `kernelSurvivedBroker: false`. This is recorded as a **measurement, not an
   assertion**, because whether a grandchild is reaped is a platform fact about
   the job object and not a property this package decides. The test asserts only
   the invariant the product owns: `shutdown()` leaves nothing of this package
   running, whichever way that measurement goes, and it kills the kernel by hand
   if it is still alive so the suite strands nothing.

---

## 7. A numbering caution for whoever files these as spec evidence

`[read in source]` The labels in these two test files (`IPY-04`, `IPY-05`,
`IPY-07`, `IPY-09`, `IPY-10`, `IPY-12`, `IPY-13`, `IPY-14`, `IPY-15`) were written
before `qualification/specs/acceptance-spec.trusted-local-v1.json` existed
(committed `f6ac93c`, 04:59; the labels first appear in `d86e180`, 06:21). **The
spec's IPY numbering is not the same as these labels.** Checked case by case:

| Label used here | What this gate actually measures | The spec case with that id is about |
|---|---|---|
| `IPY-04` | Session owns kernel identity | an exception leaves partial state |
| `IPY-05` | an activation ending does not destroy the kernel | stdin is disabled and fails fast |
| `IPY-09` | raw/rich output ordering | one tool, one parameter, no lifecycle surface |
| `IPY-12` | no automatic cell replay (+ the fd-1 cap boundary) | output is bounded and the loss is stated |
| `IPY-13` | the broker is owned by the DSH subprocess seam | late output is classified separately |
| `IPY-14` | host-side loss reconciled, crash orphans observed | kernel death is visible and nothing is replayed |
| `IPY-15` | the kernel cwd is the Session's project root | the kernel transport is authenticated |

The closest spec matches are by **oracle, not by label** — this file's `IPY-15`
covers the spec's **IPY-11** (cwd is the project root), and this file's `IPY-12`
covers part of the spec's **IPY-12** (output bounded) plus its own replay oracle.
`[measured]` The spec's IPY-15 (transport authentication) is **not** covered by
these two files; the plaintext-transport oracle is measured in
`requirements.test.ts` requirement 2 and in
`qualification/results/M11-ipython/TRANSPORT-FINDINGS.md`. A sibling agent (V3) is
mapping the spec's cases by oracle in `v3-spec-gates.test.ts`; that mapping, not
these labels, is what should be filed against the spec.

---

## 8. What this run did NOT establish

| Not established | Why |
|---|---|
| That `faults.test.ts` as a whole is green | It is **not**: 1 of 11 fails in the full-file run (§5). Reproduced on the pristine HEAD as a control. |
| The root cause of the restart flake | Characterized (the 60 s `wait_for_ready` at `broker.py:839`, empty broker logs, flaky under sequential load) but not traced inside the library's retry loop. Reported, not diagnosed. |
| That the kernel survives a real host crash | Only the in-process analogue was measured: the broker is killed from outside while the host lives. Killing the *host* process itself was not run. |
| That the scratch dir is cleaned up | It is **not** — `kernel.out`/`kernel.err` survive `shutdown()` and no removal code exists in the package. Asserted as the honest state so adding cleanup later is a visible change to the gate. |
| That a cell cannot read its own connection file | It **can** — `jupyter_client` passes `-f <path>` in `sys.argv`. Under trusted-local the cell is the kernel process, so this is not confinable without a different process boundary. Recorded as the boundary in §3. |
| The spec's IPY-15 (transport authentication) | Not this file's oracle; see §7. |
