# P2 — BRI-WAITER: the reply-before-waiter race, and the run where it loses

V5 §6.1 and V5 §18 (`BRI-WAITER`: "immediate reply cannot beat waiter
registration"). V5 §2 fact 13 records the pre-fix state as
`waiter registered before send? NO`.

## The defect, and why the window is real rather than theoretical

`packages/dsh-ipython/src/bridge.ts` embeds the Python client as a template
string. In the pre-fix client:

```python
def _send(self, tool, arguments):
    with self._lock:
        sock = self._ensure_locked()
        ...
        sock.sendall(_HEADER.pack(len(payload)) + payload)   # BYTES LEAVE HERE
    return request_id                                         # lock released

def call_sync(self, tool, arguments, timeout):
    request_id = self._send(tool, arguments)   # sent
    waiter = _SyncWaiter()
    with self._lock:
        self._waiters[request_id] = waiter     # registered AFTER
```

and the reader:

```python
request_id = message.get("requestId")
with self._lock:
    waiter = self._waiters.pop(request_id, None)
if waiter is None:
    continue                                   # THE REPLY IS DISCARDED
```

A reply that arrives between the send and the registration is popped, found to
have no waiter, and dropped. The caller then registers a waiter that nothing
will fire and blocks for its whole timeout.

**The window is not a rare interleaving.** The reader thread is blocked on
`self._lock` holding a parsed reply while `_send` holds that lock, so the reader
is the very next lock holder once the send releases. Measured here: with the
interleaving forced, the pre-fix client loses the reply on **every** run.

## The fix

Registration and send now happen under **one** lock acquisition, with a
rollback if the send itself fails:

```python
with self._lock:
    sock = self._ensure_locked()
    ...
    self._waiters[request_id] = waiter
    try:
        sock.sendall(_HEADER.pack(len(payload)) + payload)
    except BaseException:
        self._waiters.pop(request_id, None)
        raise
```

`call_sync` and `call_async` build their waiter first (the async one from the
running loop, because `create_future` must run on the loop's thread) and wait
**outside** the lock.

**The in-repo precedent, which is why this is consistency rather than
invention.** `packages/dsh-ipython/src/broker.py`'s `ShellRouter` (class at
`:495`, `register` at `:540`) already states and enforces the same rule:

> A waiter is registered under the request's `msg_id` BEFORE the request is
> sent, and this thread delivers the reply whose `parent_header.msg_id` matches.

and its `register` docstring reads "Declare interest in one request's reply.
Call BEFORE sending the request." Its reader **counts** a frame whose parent
matches no waiter instead of delivering it. The client was the one place in this
package not following the router's own rule.

## The before/after pair, on disk

| artifact | what it is |
|---|---|
| `dsh_bridge_client.before.py` | the pre-fix client, extracted mechanically from the pre-fix `bridge.ts` (sha256 `b78cc5e3bb7df19e3f0c418fae2044f843ccfa661ed624cdd56808195efbf573`) |
| `extract-client-before.ts` | the extractor; reads the template rather than copying it, so the archive cannot drift from the tree it describes |
| `bri-waiter-report.json` | the five-arm probe run: BEFORE and AFTER, as JSON |
| `mutation-prefix-red.txt` | the gate run RED with production code reverted to the pre-fix `_send` |
| `after-green.txt` | the same gate GREEN on the fixed tree |

### The five arms, from `bri-waiter-report.json`

```
client mode    ok     err       readerLookups noWaiter cleanup regSend forcedMs sends
live   sync    true   -         1             0        0       0       0.00     1
before sync    false  TIMEOUT   1             1        1       1       0.30     1
live   async   true   -         1             0        1       0       0.00     1
before async   false  TIMEOUT   1             1        1       1       0.30     1
live   sendfail false OSError   0             0        1       0       0.00     0
```

Read the two middle columns for the mechanism: in the pre-fix arms the reader
looked the reply up and found **no waiter** (`noWaiter=1`), so it discarded the
reply the host had already sent -- which is exactly the defect, observed
directly rather than inferred from the timeout. In the fixed arms the same
lookup finds the waiter (`noWaiter=0`) and the value comes back.

`regSend` is how many frames were on the wire when the waiter was registered:
`0` for the fixed client (the waiter existed first) and `1` for the pre-fix one.

`cleanup` counts pops made by the **caller**, attributed by thread id. It is
reported separately because the caller also pops its own waiter (on timeout, and
in `_async`'s `finally`); counting the two together would report a caller's
cleanup as a discarded reply. The driver's first version did exactly that and
was corrected rather than explained away.

## The mutation test: the gate goes red on the pre-fix production code

A gate that never fires and a gate that is absent produce identical evidence, so
the gate was run against the **pre-fix production code** -- `bridge.ts` restored
to its state at `1d2d032^`, test file unchanged:

```
× the LIVE client returns the reply, and the waiter exists before the frame does (sync)   10151ms
× the LIVE client returns the reply (async), and the PRE-FIX client loses it             10184ms
× the live source registers the waiter BEFORE it writes the frame (scheduling-free)          7ms
✓ the PRE-FIX client loses the reply -- the control arm, watched failing                   544ms
✓ the fix fails closed when the send itself fails: no waiter is left behind                151ms
Tests  3 failed | 2 passed (5)
```

The two live arms failed with the **real 10 s TIMEOUT**
(`TIMEOUT: probe_echo did not answer within 10.0s`), not with an assertion about
a counter -- the oracle the case actually names. Full transcript:
`mutation-prefix-red.txt`.

The fix was then restored and the same file re-run green
(`after-green.txt`): `5 passed (5)`.

## Why the test is deterministic and not "run it 100 times"

Repeating a call and hoping to lose the window reports **green on broken code**,
because the natural run usually wins. So the interleaving is forced, and the
forcing is stated rather than hidden:

`src/bri-waiter-driver.py` replaces the client's own lock with a
`SchedulingLock` that holds the **caller** (never the reader) on its first
post-send acquisition until the reader has completed a lookup. In the pre-fix
client that acquisition *is* the registration, so the reader is guaranteed to
look the reply up first and the reply is therefore guaranteed to be lost. In the
fixed client the waiter is already registered before the frame leaves.

Everything else is real: a real `BridgeServer` on a real loopback port, the real
per-cell preamble, the real client bytes, a real socket and a real reader
thread. Nothing in the client's `_send`, `call_sync`, `call_async` or
`_read_loop` is patched, stubbed or rewritten. `ObservedWaiters` only **records**
what the reader found; it never blocks (a blocking dict would deadlock, since the
reader pops while holding the lock).

The harness passes `readerWaitExpired` and `forcedWaitMs` back with every result,
so a run in which the barrier did not actually force anything is visible as such
rather than being read as a pass.

## Commands

```sh
# the gate (from packages/dsh-ipython; ONE file, never the suite)
node node_modules/vitest/vitest.mjs run src/bri-waiter.test.ts
# -> 5 passed (5)

# the probe that wrote the before/after JSON (from packages/dsh-ipython)
node --experimental-strip-types ../../qualification/results/P2-waiter/bri-waiter-probe.ts

# the authoritative typecheck, tests included (from the repo root)
node helpers/typecheck.mjs
# -> dsh-ipython: 31 files (17 production + 14 test), exit 0; typecheck: PASS
```

## A coupling this fix broke, found and repaired

`src/v4-bridge-probe.ts:596` extracted the client's frame fields with a regex
pinned to the exact `_send` signature. Adding the `waiter` parameter stopped it
matching, so `clientFrameKeys` silently became `[]` -- a measurement degrading to
empty, which reads as "the frame carries no fields" rather than as "the extractor
broke". Measured both ways against the real written client:

```
OLD regex: NO MATCH  []
NEW regex: matched   ['type','requestId','tool','arguments','leaseId','cellId','epoch']
```

Fixed with an optional parameter group, plus a throw on extraction failure so it
cannot degrade silently again. The probe's own full run was **not** executed
here: it boots a real IPython kernel, and the load-bearing claim (the extractor
matches and yields the seven frame fields) is the measurement above.
