# C11 triage — the eight real failures in integrated candidate `93f88ba`

Worktree `D:\DSH\work\wt-c11` (branch `wt/c11`), triaged at `93f88ba`.
Fixes committed in **`6bc8404`**. No production source was edited; no assertion,
bound or oracle was weakened or removed.

Each file was run **one at a time**, never two vitest processes at once.

---

## 1. Summary table

| # | Test | File | Class | Actual vs expected | Deciding evidence | Action |
|---|------|------|-------|--------------------|-------------------|--------|
| 1 | measures what upstream actually does: no refusal, and silent loss of the loser's writes | `packages/dsh-daily-work/src/durability-advanced.test.ts:500` | **ENVIRONMENT** | child exited 1 with `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` vs. an expected report file | `node --import tsx/esm` fails from the repo root and succeeds from the package dir; root `node_modules` is EMPTY, `tsx` is a junction only in `packages/*/node_modules` | FIXED: child `cwd` anchored to the test file |
| 2 | refuses the second host once the deployment-boundary guard is configured | `durability-advanced.test.ts:549` | **ENVIRONMENT** | same `ERR_MODULE_NOT_FOUND: tsx` | same | FIXED, same change |
| 3 | releases the claim on a clean close, so the next generation is not locked out | `durability-advanced.test.ts:586` | **ENVIRONMENT** | same `ERR_MODULE_NOT_FOUND: tsx` | same | FIXED, same change |
| 4 | measures that a detached grandchild survives, and that recovery does not read that as cleanup | `durability-advanced.test.ts:731` | **ENVIRONMENT** | same `ERR_MODULE_NOT_FOUND: tsx` | same | FIXED, same change |
| 5 | the stock arm declares no plugin rows, and its files hash to the committed values | `packages/dsh-daily-work/src/eco.test.ts:1388` | **STALE EXPECTATION** | actual `e12edffb…` vs pinned `4e3aa20c…` | pin = the file at `8941ad5`; `3c2b190` (P0.7) then changed exactly one non-comment line (`maxActiveSubagents: 10`→`30`) and did not move the pin. Independently corroborated: the lock's `host_profile_digest` moved `0e8e370e`→`e12edffb` citing the same two commits | FIXED: pin re-derived to `e12edffb…`, literal KEPT |
| 6 | a REAL second process is refused while the first holds the lock, over one store | `packages/dsh-daily-work/src/dep-gates.test.ts:944` | **ENVIRONMENT** | `timed out waiting for …holder.json` at **60090 ms** vs. `HomeLockHeldError` | identical `tsx` root cause. This file does NOT capture its child's stderr, so a child that died in ms surfaced as a 60 s timeout. Same child, fixed cwd: **594 ms** | FIXED, same change |
| 7 | a SIGKILLed holder frees the store for the next acquirer, with no stale-lock surgery | `dep-gates.test.ts:1075` | **ENVIRONMENT** | `the holder exited before acquiring` vs. a successful acquire | same; the child never started | FIXED, same change |
| 8 | IPY-06: foreign frames are ignored AND COUNTED, and a restart mid-sequence is a new epoch | `packages/dsh-ipython/src/v3-spec-gates.test.ts:616` | **REAL PRODUCT DEFECT** (restart path), already filed as `G-SEAM-39` | `KernelOutcomeUnknownError: cell did not reach execute_reply + idle within 120000 ms`, or `BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds` vs. a successful post-restart cell | The **`bare` arm (start→restart, no cell, no status) fails too** — the injection is not the variable. The fault is localized to `broker.py:1252` | REPORTED, not fixed |

Result after the fixes: `durability-advanced` **33/33**, `dep-gates` **37/37** (from the
repository root — the harder launch directory), `eco` **36/36**. `v3-spec-gates` remains
**intermittently red** by design of the underlying defect, described in §3.

---

## 2. What was fixed, and why these fixes are not a loosening

### 2.1 ENVIRONMENT — seven of the eight failures, one root cause

`durability-advanced.test.ts` and `dep-gates.test.ts` spawn real child processes with
`--import tsx/esm`, and both passed `cwd: process.cwd()`. `tsx` is loaded as an ESM
**loader**, before any module exists, so its own bare-specifier resolution falls back to
the process cwd. The junction farm lives in `packages/*/node_modules`, and the **repository
root's `node_modules` is empty**.

Measured directly, same command, only the directory differing:

```
$ cd D:/DSH/work/wt-c11 && node --import tsx/esm --input-type=module --eval 'console.log("ok")'
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from D:\DSH\work\wt-c11\

$ cd D:/DSH/work/wt-c11/packages/dsh-daily-work && node --import tsx/esm --input-type=module --eval 'console.log("ok")'
child-ok
```

The documented invocation is `cd packages/dsh-daily-work && vitest run src/<file>.test.ts`
(see `qualification/results/M9.4-durability-advanced/FINDINGS.md:273`), which is exactly the
form under which `process.cwd()` happens to be the package — so the assumption was invisible
until the suite was launched from the repository root.

**Why the same cause produced two different-looking symptoms, which is why it read as two
problems.** `durability-advanced.test.ts` captures its child's stderr and reported the real
error (`Cannot find package 'tsx'`). `dep-gates.test.ts` does not, so a child that died in
milliseconds was indistinguishable from a child that hung: DEP-06 surfaced as
`timed out waiting for …holder.json` at **60090 ms** and DEP-07 as `the holder exited before
acquiring`. Neither was a lock or teardown problem. The 60090 ms is the test's own
`waitForFile` 60 s budget, not slow teardown — the child had been dead the whole time.

**The fix.** A `CHILD_CWD` constant per file, derived from the test file's own location
(`resolve(HERE, '..')` in `durability-advanced.test.ts`, `resolve(import.meta.dirname, '..')`
in `dep-gates.test.ts`), used at the spawn sites. The child's module resolution no longer
depends on the launch directory, which is the property the assertions actually need. This
matches the precedent already in this repository: `qualification/runners/v6-rec03-crash-before-admission.mjs`
resolves its packages through absolute `file:///` URLs rather than through cwd.

No assertion, timeout, or bound was changed. The one remaining `process.cwd()` in
`dep-gates.test.ts:741` is the mounted fs provider's workspace root — not a
module-resolution input — and is deliberately left alone.

### 2.2 STALE EXPECTATION — `eco.test.ts` ECO-07

The pin was `4e3aa20c…`; the file's true digest is `e12edffb…`. Hashed at each commit:

| Commit | `profiles/daily-candidate/cordis.patch.yml` sha256 |
|---|---|
| `8941ad5` (S1: `includeShippedRoot: false`) | `4e3aa20cbc23b8cedbfc7205aac0756f37e1107a4ee556d38760dc3769ceedeb` ← the pin |
| `3c2b190` (P0.7) | `e12edffbbf69d531454f83a242863b7586e65f222f7c2f8c4151bf4918b43114` |
| `HEAD` | `e12edffbbf69d531454f83a242863b7586e65f222f7c2f8c4151bf4918b43114` |

`3c2b190` changed exactly ONE non-comment line and did not move the pin:

```
-    maxActiveSubagents: 10
+    maxActiveSubagents: 30
```

The red was therefore **the gate working** — it caught a profile change that shipped without
its digest being re-derived, which is the entire reason this constant is a literal.

**Re-derived, not absorbed.** The new value is not "whatever the file now contains": it is
independently corroborated by the project's own identity tooling, which re-hashed the same
file for an unrelated reason and recorded the same number.
`compatibility.lock.json`'s `host_profile_digest` moved `0e8e370e…` → `e12edffb…`, and the
re-derivation note (`5b014e9`, `qualification/results/C0-identity/rederive.txt`) attributes
that move to `3c2b190` (P0.7) and `8941ad5` (S1) together. Two independent computations of
the same file agree.

The literal is **kept** (a computed digest would agree with anything and catch nothing), the
stock arm's own assertions are untouched, and the provenance comment records this fifth move
as **EXECUTABLE**, like the fourth.

---

## 3. REAL DEFECT — the kernel restart path is intermittently broken

**Status: REPORTED, NOT FIXED.** Fixing it needs production source (`broker.py`), which is
outside this triage's remit.

**Location.** `packages/dsh-ipython/src/broker.py:1252`, inside `Broker.restart`:

```python
def restart(self, request):
    ...
    self._km.restart_kernel(now=True)          # :1249
    self._kc = self._km.client()
    self._kc.start_channels()
    self._kc.wait_for_ready(timeout=60)        # :1252  <-- the timeout is raised here
```

**Observed failures**, two distinct shapes from the same path:

- `KernelTransportError: BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds`
  (the broker's own `wait_for_ready` budget, surfaced through `kernel.ts:442`);
- `KernelOutcomeUnknownError: cell did not reach execute_reply + idle within 120000 ms`
  (`kernel.ts:580`), when the restart "succeeded" but the following cell never settled.

**Minimal reproduction** (deterministic enough to be useful; run from `packages/dsh-ipython`):

```
C11_TRIALS=6 node --import tsx/esm c11-ipy06-diag.mts
```

The probe drives the product's own `KernelHost` — `start()` then `restart()` — and prints the
host's private `diagnostics` buffer, which is where the broker's traceback actually is. That
traceback is the decisive evidence and was not previously available: the broker logs
`op restart failed: <traceback>` to its stderr, the host stores it in `diagnostics`, and no
failing assertion prints it. Result: **1/6 passed**, and the traceback names
`broker.py:1252 → wait_for_ready → RuntimeError: Kernel didn't respond in 60 seconds`.

**What the arms establish.** Four arms, 5 trials each, through `KernelHost`
(`c11-ipy06-arms.mts`):

| Arm | Sequence | Passed |
|---|---|---|
| `bare` | start → restart (no cell, no status) | **3/5** |
| `cell` | start → cell → restart | 4/5 |
| `status` | start → three `status()` → restart | 2/5 |
| `both` | start → cell + three `status()` during it → restart (**IPY-06's exact sequence**) | **5/5** |

The arm with the *least* stimulus fails while IPY-06's exact sequence passes 5/5. **The
injection is not the variable** — which independently reconfirms, on a larger sample,
`G-SEAM-39`'s own refutation of the outstanding-shell-waiter hypothesis.

**Hypotheses tested and REFUTED** (each with a standalone control, no DSH code in the loop):

1. *Stale `stdout`/`stderr` handles.* `broker.py:678,713` opens `kernel.out`/`kernel.err`
   once and `jupyter_client`'s `_async_restart_kernel` replays `self._launch_args` verbatim.
   Probe: reuse the same handles across a restart — **passed**.
2. *Port collision* (`newports` defaults to `False`, so the replacement binds the ports the
   killed kernel held). Loop of 10 restarts, plain `jupyter_client`: **10/10 passed**;
   across probes, **20/20**. Then the decisive arm comparison, 8 trials each through the
   product's own `KernelHost`: default **7/8** vs `newports=True` **5/8** — i.e. turning the
   workaround ON made it **worse**. Refuted twice, from both directions.
3. *Leaked channel client.* `broker.py` replaces `self._kc` without calling
   `stop_channels()` on the old one. Single-variable probe (A: `stop_channels()` before
   restart; B: none, as `broker.py` does): **B passed 6/6** — refuted.
4. *Orphaned IOPub pump thread.* Instrumented a **copy** of `broker.py` to census
   `iopub-pump` threads at every start/stop. Output on failing trials:
   `STOP_PUMP old_thread_alive=False pump_threads_still_running=[]` — the old thread always
   exits cleanly. Refuted.
5. *The IPY-06 injection itself* (three `status()` calls, and/or a running cell). Refuted by
   the four-arm table above: the **bare** arm fails and the **full** sequence passed 5/5.

**One candidate was tested at scale and REFUTED.** With
`restart_kernel(now=True, newports=True)` the bare arm first scored 5/6 against a 3/6
baseline, which looked like an improvement. Re-running both arms at 8 trials reversed it:

| Arm (8 trials each, same probe, same host) | Passed |
|---|---|
| `newports` default (`False`) — what `broker.py:1249` does | **7/8** |
| `newports=True` | **5/8** |

`newports=True` was **worse**, and the failure mode was unchanged (`wait_for_ready` 60 s
timeout, plus one 120 s `KernelOutcomeUnknownError`). The earlier 5/6-vs-3/6 gap was noise:
the bare arm's failure rate across this session ranged from **1/6 to 7/8** on identical code,
so a two-trial or six-trial comparison cannot decide anything here. **Port reuse is refuted
as the cause**, and `broker.py` must not be changed on the strength of the earlier figure.

The honest summary of the cause: **the restart path is intermittently broken, the failure is
localized to `broker.py:1252`, and the variable that decides pass/fail has NOT been
identified.** Five specific hypotheses were tested and refuted; none survived. The failure
rate is high enough to matter (roughly 1/8 to 5/8 of restarts, varying run to run) and low
enough that the two-trial experiment shape `G-SEAM-39` used to refute its own first
hypothesis cannot settle the question — which is itself the most transferable finding here:
**this defect needs a sample of at least ~20 trials per arm, not two.**

**A correction to the existing `G-SEAM-39` record.** That entry infers from an **empty
`kernel.err`** that "the REPLACEMENT KERNEL NEVER STARTED". That inference is **invalid**:
an empty `kernel.err` (and empty `kernel.out`) is the normal state even on a **fully
successful** start, measured directly —

```
SUCCESSFUL start -> kernel.err bytes: 0
SUCCESSFUL start -> kernel.out bytes: 0
```

Moreover, on failing trials the attribution marker
`dsh_attribution_bootstrap.loaded` **is present** in the preserved kernel root, which means
the replacement kernel *did* start and did run its bootstrap. The empty log therefore
carries no information about whether the replacement started, and the "replacement kernel
never started" reading should be withdrawn. The correct statement is the weaker one the
traceback supports: **the replacement started but did not become ready on the channels the
broker reconnected to, within 60 s.**

**What a correct fix would look like** (for whoever owns `broker.py`):

- Make the restart path wait on the channels it actually reconnected to, rather than
  reusing a client whose sockets were created against the previous kernel. `restart()` is
  the only place in the broker that replaces `self._kc` without calling `stop_channels()`;
  `shutdown()` does call it. That asymmetry is the most suspicious surviving detail, though
  the standalone arm-B probe above did **not** reproduce a failure from it, so it is a lead
  rather than a diagnosis.
- Do **not** reach for `newports=True`: it was measured at 5/8 against a 7/8 baseline.
- Whatever is chosen, the broker should log the **replacement kernel's pid and the ports it
  bound** at restart, so the next failure is attributable from the log instead of by
  elimination. The current traceback localizes the timeout but not the cause. This
  instrumentation is the highest-value next step: five hypotheses have now been eliminated
  by black-box probing, and what is missing is a log line that says what the replacement
  kernel was actually listening on.
- Any further experiment needs **>= 20 trials per arm**. The baseline failure rate moved
  between 1/8 and 5/8 across this session on identical code, so smaller samples produce
  confident wrong answers — this report's own first `newports` result was one of them.

**Why the gate is not simply widened.** `v3-spec-gates.test.ts`'s per-test budget is already
`300_000` ms and the failure is not a slow teardown — it is a `wait_for_ready` that never
completes. Raising the budget would convert a visible intermittent product failure into a
slow one, which is exactly the outcome `vitest.config.ts` says must remain visible. The test
is left as it is.

---

## 4. Not one of the eight, but observed and worth recording

Running `eco.test.ts` and `dep-gates.test.ts` together (which is **not** how these files are
meant to be run, and not how they were triaged) surfaced one further failure that is
**outside the eight**:

`dep-gates.test.ts:349` — *the installed spec is byte-identical to the audit package copy* —
fails with `ENOENT` on
`C:/Users/hzq00/Downloads/DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20/dsh-audit-2026-09-20/delivery/acceptance-spec.json`.

The **external audit package has been deleted from this machine** (the whole
`DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20` directory is gone from `Downloads/`).
This test **passed** during the earlier isolated `dep-gates` run in this same session and
fails now, which dates the deletion to the middle of this triage. It is a pure
**ENVIRONMENT artifact** and is **not** a stale expectation: the test asserts the installed
spec is byte-identical to the audit's copy and pins the digest `2fe95835…`, which is a real
provenance claim that must not be weakened to accommodate a missing input. It fails
**honestly** — an absent input must not read as a pass — so it is left exactly as it is.
Note this means `dep-gates.test.ts` cannot be reported green until that external package is
restored: the file stands at **36/37**, with the single failure being this unrelated
`ENOENT`. The two tests that were this triage's subjects both pass, at **655 ms** (DEP-06,
previously `60090 ms`) and **153 ms** (DEP-07, previously "the holder exited before
acquiring").

---

## 5. Provenance of the measurements in this report

- All vitest runs: one file at a time, no two vitest processes concurrently, matching the
  constraint that parallel runs caused real-kernel timeouts.
- Both packages rebuilt before measuring, with the real compiler:
  `node D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p packages/<pkg>/tsconfig.json`
  — exit 0 for both (`npx tsc` was not used).
- The post-fix figures in §1 were taken from the **repository root**, i.e. the launch
  directory under which the original seven failures were reproduced, so the fix is verified
  against the failing condition rather than against the convenient one.
- The restart probes are diagnostic scratch files (`c11-ipy06-*.mts`) inside
  `packages/dsh-ipython/`; they are **not** part of the deliverable and are removed before
  this work is considered finished. Their instrumented `broker.py` copies live only in
  `%TEMP%\c11-restart-probe\`, never in the repository.
- No `as any` / `as never` was introduced. Nothing was pushed.
