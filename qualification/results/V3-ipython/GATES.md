# V3 — IPYTHON family, IPY-01..IPY-15

Trusted-local acceptance spec: `qualification/specs/acceptance-spec.trusted-local-v1.json`
Deployment identity: `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
(verified by `python qualification/results/T1-spec/verify-identity.py`, 30/30)

Every claim below is labelled `[measured]` (produced by a run recorded in this
directory) or `[read in source]` (read from the tree, not executed).

---

## 0. THE LABEL-VS-SPEC TABLE — read this before citing any case id

**T6's gate labels inside `lifecycle.test.ts` / `faults.test.ts` are NOT the
spec's case ids.** They were written before this spec was installed and they
collide. Two of the collisions are actively misleading, and the root agent's
brief contained one of them.

| Spec case | Spec requirement | T6's label for the SAME oracle | Collides? |
|---|---|---|---|
| IPY-01 | a real IPython shell, not a CPython imitation | (no T6 label; `requirements.test.ts` req 1) | no |
| IPY-02 | the namespace persists across cells | (no T6 label; `requirements.test.ts` req 3) | no |
| IPY-03 | top-level await works with no wrapper | (no T6 label; `requirements.test.ts` req 4) | no |
| IPY-04 | **an exception leaves partial state and does not claim rollback** | T6's "IPY-04" = *Session owns kernel identity* | **YES — different case** |
| IPY-05 | stdin is disabled and fails fast | T6's "IPY-05" = *an activation ending does not destroy a kernel* | **YES — different case** |
| IPY-06 | only the matching reply and idle settle a cell | (no T6 label; `requirements.test.ts` req 7) | no |
| IPY-07 | interrupt then reuse, with honest outcome classification | T6's "IPY-07" = cell overrun + restart semantics | partial |
| IPY-08 | a natural activation end rebinds or reports loss | (no gate) | n/a |
| IPY-09 | one tool, one parameter, no lifecycle surface | T6's "IPY-09" = *raw and rich output ordering* | **YES — different case** |
| IPY-10 | the model cannot own kernel lifecycle | T6's "IPY-10" = same subject | **same** |
| IPY-11 | **the kernel cwd is the project root** | T6's "IPY-15" = same oracle | **YES — the root agent called this IPY-15** |
| IPY-12 | output is bounded and the loss is stated | T6's "IPY-12" = *no automatic cell replay* | **YES — different case** |
| IPY-13 | late output classified separately, never rides another cell | (no T6 label; `requirements.test.ts` req 9) | no |
| IPY-14 | kernel death is visible and nothing is replayed | T6's "IPY-14" = *host-side loss reconciled, crash orphans* | **YES — different case** |
| IPY-15 | **the kernel transport is authenticated and frames are bounded** | T6's "IPY-15" = *kernel cwd* | **YES — different case** |

So `lifecycle.test.ts`'s `IPY-15: the kernel working directory is the Session's
project root` establishes the spec's **IPY-11**, and `lifecycle.test.ts`'s
`IPY-04: the Session owns kernel identity` establishes **no case in this spec** —
that invariant is `ID`/`CMP` territory, not an IPY oracle.

---

## 1. THE GATE TABLE

Build: HEAD `cf5491d`, branch `ipython-native`. Digests in `build-identity.txt`.
Run transcripts in this directory; the run transcript is what each case cites,
because a test file's digest moves whenever any of nine agents edits the tree,
while a transcript is stable once written.

| Case | Assertion (short) | Exact command | Measured result | Verdict |
|---|---|---|---|---|
| IPY-01 | real IPython shell + a magic, in one cell | `vitest run src/v3-spec-gates.test.ts -t "IPY-01"` | `shellModule=ipykernel.zmqshell`, `shellClass=ZMQInteractiveShell`, `isZmqShell=True`, magic output contains the marker | **PASS** |
| IPY-02 | namespace persists; cell 2 defines nothing | `-t "IPY-02"` | `CELL2_OK 12 200 {"a": 1}`; cell-2 source asserted free of the 4 definitions; same epoch | **PASS** |
| IPY-03 | top-level await, asyncio AND native call, no wrapper | `-t "IPY-03"` | `asyncioValue=42`, `nativeValue={"marker":"NATIVE-SETTLED","tag":"from-the-cell"}`; no `async def`/wrapper in source | **PASS** |
| IPY-04 | exception leaves partial state; **no rollback claimed** | `-t "IPY-04"` | `survivorReadBack="ipy04_survivor is still assigned"`; traceback has the failing line; model text matches no rollback phrasing | **PASS** |
| IPY-05 | stdin disabled, fails fast, releases the slot | `-t "IPY-05"` | `input` 453 ms, `getpass` 34 ms, both `StdinNotImplementedError`; `busy=false` after each; next cell accepted | **PASS** |
| IPY-06 | only its own reply+idle settle a cell | `-t "IPY-06"` | last line present after 3 interleaved correlated requests; `foreignFrames` reported (baseline 1, control-armed); restart advances epoch, namespace gone | **PASS** (see §3) |
| IPY-07 | interrupt then reuse, honest classification | `vitest run src/faults.test.ts -t "requirement 8"` and `-t "IPY-07"` | CPU loop → `interrupted` + `KeyboardInterrupt` + reusable; await-suspended → `unknown` + reset + epoch advanced; timeout → `unknown`, reason names `6000 ms`, pid replaced; restart → epoch 1→2, pid replaced, `kernelCwdEnforced=true`, cwd preserved | **PASS** |
| IPY-08 | activation end rebinds or states loss | — | needs a live provider; `live_provider_budget_authorized=false` | **BLOCKED_EXTERNAL** |
| IPY-09 | ONE tool `ipython`, ONE param `code`, no lifecycle surface | `node qualification/runners/v3-ipython-boot.mjs` | real boot, `toolCountAgentKey=27`, `ipythonParameterNames=["code"]`, `ipythonIsOnlyParameter=true`, `forbiddenLifecycleTools=[]`, `pythonExecAliasPresent=false` | **PASS** |
| IPY-10 | the model cannot own kernel lifecycle | `vitest run src/lifecycle.test.ts -t "IPY-10"` | `has_ctx=false`, `has_kernel_service=false`, `lifecycle_callables=[]`, `cap_or_timeout_symbols=[]`, `control_env="pipe"`; self-shutdown → NEW generation with loss stated | **PASS** |
| IPY-11 | kernel cwd is the project root, verbatim | `-t "IPY-11"` (mine) + `lifecycle.test.ts` cwd gates | `cwdReportedByCell="D:\DSH\work\dsh-native-daily"` = the requested root, `isTempDir=false`, relative path resolved inside, `kernelCwdEnforced=true`; cwd≠scratch separation holds | **PASS** |
| IPY-12 | bounded output, loss stated, cap recorded | `-t "IPY-12"` (mine) + `faults.test.ts` req 10 + fd-1 gate | cap `8192`; `reportedTotalBytes=3276818`; model text says `TRUNCATED`, names the true total, names the spill path, says `NOT complete`; spill file is 3,276,818 bytes | **PASS** |
| IPY-13 | late output separate; during-a-later-cell UNDECIDABLE | `-t "IPY-13"` (two tests) | **clause 1 PASS**: post-return write is late, rides nothing. **clause 2 FAIL**: the straddling write is ATTRIBUTED to the later cell (`lateCount=0`, marker inside cell three's stdout) | **FAIL** (see §2) |
| IPY-14 | death visible, state LOST, nothing replayed, Session survives | `-t "IPY-14"` (mine) + `faults.test.ts` req 11 | epoch 1→2, pid replaced, `volatileStateLost=true`, reason present; model text says `LOST` and `Nothing was replayed`; `hasKernel=true` after; append-only marker has exactly ONE line | **PASS** |
| IPY-15 | authenticated transport + over-limit frame LOST with a count | `-t "IPY-15"` (mine) | `transport=tcp`, `curveKeysPresent=true`, `plaintextWarningSeen=false`, connection file has both curve keys, mode `0o666`; over-limit refused on encode AND decode; **`droppedFrames` has no producer** | **FAIL** (see §2) |

Run transcripts cited above:

- `run-v3-spec-gates.txt` — 12/12 passed, 51.64 s
- `run-lifecycle.txt` — 15/15 passed, 135.53 s
- `run-faults.txt` — 11/11 passed, 73.85 s
- `IPY-09-boot.txt` + `IPY-09-tool-surface.json` — real boot, port released
- `build-identity.txt` — HEAD, identity, lib/ and src/ digests

---

## 2. THE TWO CASES THAT FAIL, WITH THEIR MECHANISMS

### IPY-13 clause 2 — silent mis-attribution of a straddling write `[measured]`

Spec oracle: *"A write landing DURING a later cell is reported as undecidable
rather than attributed."*

Measured: it is **attributed**. Cell three's stdout was verbatim

```
tick 0
tick 1
IPY13-DURING-LATER-CELL
tick 2
tick 3
cell-three-settled
```

`lateCount=0` — the write was not reported as late or unattributed at all. A
model reading cell three's result sees the marker interleaved with its own
prints and will attribute it to cell three.

Mechanism, and it is upstream of the broker: `ipykernel/iostream.py` resolves a
stream's parent header from a `contextvars.ContextVar`, falling back to a
GLOBAL when the contextvar is unset. `threading.Thread` starts with an EMPTY
context (an asyncio Task would copy one), so a background writer never sees the
contextvar and takes the global — which holds whichever cell most recently set
it, i.e. the LATER cell. The kernel therefore stamps the straddling write with
cell three's `msg_id`, and `broker.py`'s router sees `parent == sink.msg_id`
with the cell not yet idle, which is indistinguishable from the cell's own
output.

The broker's router is correct on the information it has. Distinguishing the two
cases needs a signal the transport does not carry. **Clause 1 holds**: a
post-return write IS classified late, carries the originating cell's id, and
rides neither cell.

### IPY-15 — the over-limit count has no producer `[measured]` + `[read in source]`

Spec oracle: *"An over-limit frame is reported as LOST with a count, never as
empty output."*

What holds: an over-limit frame is refused in BOTH directions. `encodeFrame`
throws `FrameError` above `MAX_FRAME_BYTES` (4,194,304), and `FrameDecoder`
rejects on the DECLARED length before buffering — measured message: `declared
frame length 4194305 exceeds the 4194304-byte limit`. No bytes are silently
lost at that layer.

What does not hold: the **count**. `CellResult.stdout.droppedFrames` is the
field the clause names, and it is structurally always 0:

- `[measured]` a normal cell reports `droppedFrames: 0`
- `[read in source]` `OutputBuffer.note_dropped_frame` (`broker.py:139`) — the
  only writer of that counter — has **ZERO call sites** (counted by regex over
  `broker.py`: definition minus call sites = 0)
- `[read in source]` `ipython-tool.ts:69` has a renderer branch for
  `droppedFrames > 0`, so **that branch is dead code**

The case is FAIL because the spec asks for a count that cannot currently be
non-zero. The gate asserts the measured state, so wiring a producer fails here
and has to be stated.

Also `[measured]`, a mislabelled field worth knowing: `status.ipythonVersion`
reports **3.14.3**, which is the *Python* version, not the IPython version —
`broker.py` reads `language_info.version` (`broker.py:465`). A reader would
reasonably trust the field name.

---

## 3. IPY-06: the restart timeout, and what it turned out to be

The root agent reported `IPY-06` failing with `BROKER_FAILURE: RuntimeError:
Kernel didn't respond in 60 seconds` and hypothesised that the injected
`status()` calls broke the restart. **That hypothesis is refuted by experiment**
— recorded in `experiment-restart-single-variable.txt`.

All arms, `[measured]`:

| Arm | Shape | Result |
|---|---|---|
| A | `start()` → `restart()` | PASS 2,080 ms |
| B | `start()` → cell → 3× `status()` → `restart()` | PASS 2,027 ms |
| C | `start()` → cell → `restart()` | FAIL 60,983 ms |
| C1/C2/C3 | same as C, three trials | FAIL 61,048 / 60,937 / 60,059 ms |
| hand-built host + explicit `kernelWorkingDirectory` | | FAIL 60,980 ms |
| **`KernelService` (PRODUCT PATH)** | `runCell` → `restart` | **FAIL 63,725 ms** |
| single-variable, WITH intervening `status()` | | PASS 1,823 ms |
| single-variable, WITHOUT intervening `status()` | | PASS 11,852 ms |

Conclusions, stated at the strength the data supports:

1. The injected-`status()` hypothesis is **refuted**: both single-variable arms
   pass, and arm B (with injection) passed while arm C (without) failed.
2. The failure **is reachable on the product path**, not only through a
   hand-built `KernelHost` — so it is not merely the G-SEAM-36 harness shape.
3. It is **not deterministic**. Four consecutive failures at ~61 s were followed
   by two consecutive passes on the same machine with the same code. The
   distinguishing feature of the failing window was machine load (the whole
   suite plus nine sibling agents); the passing runs were single tests.
4. The failure is always at `broker.py:839` `self._kc.wait_for_ready(timeout=60)`
   with the replacement kernel's `kernel.err` **EMPTY (0 bytes)** — the kernel
   did not start and fail, it did not start. That is consistent with a port
   bind collision during `restart_kernel(now=True)`, which picks NEW random
   ports for the replacement kernel; but this run did **not** isolate a bind
   error, so it is a candidate and not a finding.

**IPY-06 is filed PASS on its own oracle.** The oracle is "the cell is completed
only by its own reply plus idle, a foreign frame does not complete it, and the
number of ignored foreign frames is reported" — all three are measured and the
restart clause of the *stimulus* is exercised as the epoch-advance half. The
restart reliability problem is filed separately below, because filing IPY-06
FAIL would assert that its oracle was not established, which is not true.

**Open, recorded as a finding rather than a verdict:** restart is unreliable
under load. `faults.test.ts`'s IPY-07 restart gate passes in isolation (4.9 s
measured) and the same operation failed 4/4 during a loaded window. A gate whose
result depends on machine load is a gate a reader cannot trust either way. This
is the single most valuable follow-up in this family, and the next measurement
would be a `netstat`/bind-error capture at the moment of failure.

---

## 4. WHAT WAS BUILT, AND WHAT WAS NOT

New file: `packages/dsh-ipython/src/v3-spec-gates.test.ts` — 12 tests covering
the spec cases whose oracle nothing else established (IPY-01, 02, 03, the
model-text half of 04, the slot-release half of 05, the count half of 06, 11,
the projection half of 12, both clauses of 13, the model-text and
Session-survives halves of 14, and 15).

New runner files: `qualification/runners/v3-ipython-surface.mjs` (the boot
probe) and `qualification/runners/v3-ipython-boot.mjs` (its driver, through the
shared `boot-harness.mjs` so the port is bound-not-guessed, killed, and
verified released). One patch overlay: `v3-ipython-surface.patch.yml`, which
inserts the PROBE ONLY and no tool row — the case is what the profile's own
composition registers.

**Not rewritten:** `lifecycle.test.ts` (15/15) and `faults.test.ts` (11/11)
were read, run, and mapped. Their T6 labels were left as they are; the mapping
lives in §0 so the labels cannot be mistaken for spec ids.

**Not done:** IPY-08 has no gate and needs a live provider. A defect-fix for
IPY-13 clause 2 or the IPY-15 count would be an architecture change (a process
boundary for the first, a broker change for the second), not a test.

---

## 5. CLEANUP

`[measured]` No `broker.py` or `ipykernel_launcher` process of this family
survived: a process-table scan after the last run found none, and the boot
driver reported `portReleased: true` for both boots (7364, 8019). Every test
shuts its host down in `afterEach`; the temporary experiment file
`v3-restart-experiment.test.ts` was deleted after its run.
