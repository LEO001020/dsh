# V3 experiment: is the restart timeout caused by an injected status()?

NOT A GATE. This is the record of a hypothesis test, kept because the hypothesis
was the root agent's and the answer is a refutation. The temporary test file
(`src/v3-restart-experiment.test.ts`) was deleted after the run.

The raw console transcript of the DECISIVE round is
`experiment-restart-single-variable.txt`, captured unedited. This file adds the
three earlier rounds and the analysis, because those rounds are what make the
refutation interpretable.

Every line below is `[measured]` console output from a real ipykernel.

---

## ROUND 1 — three arms, differing in what happens between start and restart

```
ARM-A {"arm":"A: start -> restart immediately","ok":true,"elapsedMs":2080,"pidBefore":8512,"epochBefore":1,"epochAfter":2,"error":null}
ARM-B {"arm":"B: start -> cell -> 3x status() -> restart","ok":true,"elapsedMs":2027,"pidBefore":40260,"epochBefore":1,"epochAfter":2,"cellOutcome":"ok","cellForeignFrames":1,"error":null}
ARM-C {"arm":"C: start -> cell (no injection) -> restart","ok":false,"elapsedMs":60983,"epochBefore":1,"epochAfter":null,
       "error":"KernelTransportError: BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds"}
```

**ARM B (WITH the injection) PASSED; ARM C (WITHOUT it) FAILED.** That inverts
the hypothesis under test, which predicted the opposite.

---

## ROUND 2 — is it deterministic? Three trials of the failing shape

```
trial-1 {"ok":false,"elapsedMs":61048,"pidBefore":40496,"epochBefore":1,"error":"...Kernel didn't respond in 60 seconds"}
trial-2 {"ok":false,"elapsedMs":60937,"pidBefore":1420, "epochBefore":1,"error":"...Kernel didn't respond in 60 seconds"}
trial-3 {"ok":false,"elapsedMs":61059,"pidBefore":21724,"epochBefore":1,"error":"...Kernel didn't respond in 60 seconds"}
```

3/3 failed at ~61 s, in the same window as round 1's failure.

Broker stderr at failure, identical in all three:

```
[broker] op restart failed: Traceback (most recent call last):
  File "packages/dsh-ipython/src/broker.py", line 934, in main
    result = broker.restart(request)
  File "packages/dsh-ipython/src/broker.py", line 839, in restart
    self._kc.wait_for_ready(timeout=60)
  File "jupyter_client/client.py", line 211, in _async_wait_for_ready
    raise RuntimeError("Kernel didn't respond in %d seconds" % timeout)
RuntimeError: Kernel didn't respond in 60 seconds
```

Diagnostics captured at the failure point:

```
scratchEntries:        ["kernel.err","kernel.out"]
kernelErrBytes:        0
kernelErrTail:         ""
kernelErrMentionsBind: false
```

The replacement kernel's `kernel.err` is **EMPTY (0 bytes)**. The kernel did not
start and then fail; it did not start.

---

## ROUND 3 — is the PRODUCT path affected, or only a hand-built host?

The question that decides whether this is a harness fact (the G-SEAM-36 shape) or
a product defect.

```
PRODUCT (KernelService: runCell -> restart, twice in one session)
  -> BROKER_FAILURE: AttributeError: 'NoneType' object has no attribute 'register'
     elapsed 63725 ms

ISOLATE-A (hand-built host WITH an explicit kernelWorkingDirectory)
  {"ok":false,"elapsedMs":60980,"epochAfter":null,
   "error":"KernelTransportError: BROKER_FAILURE: RuntimeError: Kernel didn't respond in 60 seconds"}
```

**The product path failed too**, with a DIFFERENT error:
`AttributeError: 'NoneType' object has no attribute 'register'` -- which is
`router.register(msg_id)` at `broker.py:578`/`637` being reached with
`self._router is None`, i.e. the router had been torn down and not rebuilt. So
there is a second, distinct failure mode in the same operation, and it is not a
pure port-bind timeout.

`ISOLATE-A` shows that giving the hand-built host the service's explicit
`kernelWorkingDirectory` does NOT fix it, so that candidate difference is
eliminated.

---

## ROUND 4 — THE SINGLE-VARIABLE TEST (the decisive one)

Same host, same cell, same restart; the ONLY difference is whether a `status()`
is issued between the cell and the restart. Back to back, one file, one worker.
Raw transcript: `experiment-restart-single-variable.txt`.

```
with-status    {"label":"with-status",   "ok":true,"elapsedMs":1823, "pidBefore":31804,"statusEpochBeforeRestart":1,   "epochAfter":2,"error":null}
without-status {"label":"without-status","ok":true,"elapsedMs":11852,"pidBefore":29972,"statusEpochBeforeRestart":null,"epochAfter":2,"error":null}
```

**BOTH PASS.** The hypothesis is refuted twice over: arm B passed with the
injection while arm C failed without it, and the controlled single-variable arms
both pass.

Note the timing asymmetry: `without-status` took **11,852 ms** against
`with-status`'s **1,823 ms** -- 6.5x slower for the same operation. The
`without-status` shape is the one that timed out at 60 s in rounds 1-3, and here
it completed at 11.9 s. That is consistent with a load- or timing-sensitive path
being approached, but it is not by itself a mechanism.

---

## WHAT THIS ESTABLISHES, AND WHAT IT DOES NOT

Established:

1. An intervening `status()` does **not** break a restart. Refuted by a
   controlled single-variable experiment, in both directions.
2. The failure is reachable on the **product path** (`KernelService`), so it is
   not merely the hand-built-host shape of G-SEAM-36.
3. There are **at least two distinct failure modes**: the 60 s `wait_for_ready`
   timeout with an empty `kernel.err`, and
   `AttributeError: 'NoneType' object has no attribute 'register'` from a
   torn-down router.
4. The failure is **not deterministic across windows**: 4/4 failures at ~61 s in
   one window, then 2/2 passes on the same machine with the same code.

NOT established:

- The root cause. A port-bind collision during `restart_kernel(now=True)` --
  which picks NEW random ports for the replacement kernel -- is a **candidate**:
  it explains a silent, non-starting kernel, and the machine had ~22 other
  node/python processes plus nine sibling agents. But no bind error was
  captured, so it stays a hypothesis and must not be recorded as a finding.
- Whether the two failure modes share a cause.

## THE NEXT MEASUREMENT, IF ANYONE CONTINUES THIS

Capture, at the moment of failure, the ports named in the replacement kernel's
connection file (`netstat -ano` for those ports) plus the connection file
itself. If the ports are held, the finding is a port collision in
`restart_kernel` and the fix is an explicit port range or a retry. If they are
free and the kernel is silent, the finding is inside `jupyter_client`'s restart
path and the fix is to stop relying on `now=True` plus `wait_for_ready` without a
readiness handshake of our own.
