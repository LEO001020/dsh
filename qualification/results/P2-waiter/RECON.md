# P2 / BRI-WAITER — reconnaissance, committed before the edit

Commit-early discipline (round-3 `ROUND3-COMMIT-EARLY.md`). This file records
what was READ, with line numbers, so that a lost model call does not lose the
reconnaissance.

> **LINE NUMBERS BELOW ARE PRE-FIX** (the state at `3081207`, before the edit).
> Post-fix, in the same file: `_send` `:1503`, `call_sync` `:1557`,
> `call_async` `:1566`. `_read_loop` `:1464` and `_ensure_locked` `:1497` were
> not touched.

## The defect, re-verified in THIS worktree (not taken on trust)

`packages/dsh-ipython/src/bridge.ts`, embedded Python client
(`export const PYTHON_CLIENT_SOURCE`, starts `:1325`).

`_send` at `:1503`:

```python
    def _send(self, tool, arguments):
        with self._lock:
            sock = self._ensure_locked()
            self._counter += 1
            request_id = "r%d" % self._counter
            payload = _json.dumps({...}).encode("utf-8")
            if len(payload) > _MAX_FRAME_BYTES:
                raise BridgeError(...)
            sock.sendall(_HEADER.pack(len(payload)) + payload)
        return request_id          # <-- lock released HERE, bytes already gone
```

`call_sync` at `:1525`:

```python
    def call_sync(self, tool, arguments, timeout):
        request_id = self._send(tool, arguments)     # bytes leave the process
        waiter = _SyncWaiter()
        with self._lock:
            self._waiters[request_id] = waiter       # registered AFTER the send
        if not waiter.event.wait(timeout):
            ...
            raise BridgeError("TIMEOUT", ...)
```

`call_async` at `:1536` has the identical shape (`_send` first, `_AsyncWaiter`
second, register third).

The reader side, `_read_loop` at `:1464`:

```python
            request_id = message.get("requestId")
            with self._lock:
                waiter = self._waiters.pop(request_id, None)
            if waiter is None:
                continue                                  # <-- REPLY DISCARDED
```

So a reply that arrives between `_send` releasing `_lock` and `call_sync`
re-acquiring it is popped by the reader, found to have no waiter, and dropped.
The caller then registers a waiter that nothing will ever fire, and blocks for
the whole timeout. The reply is lost silently -- no log, no counter, no error
until the timeout.

Note the window is not exotic: the reader is ALREADY BLOCKED on `self._lock`
(holding the parsed reply) while `_send` holds it. The moment `_send` releases,
the reader is the next lock holder with no work to do first. This is why the
window is a real interleaving rather than a theoretical one.

## The in-repo precedent (V5 §6.1 says to cite it)

`packages/dsh-ipython/src/broker.py`, `ShellRouter` (class at `:495`).
Its docstring states the rule in words:

> A waiter is registered under the request's `msg_id` BEFORE the request is
> sent, and this thread delivers the reply whose `parent_header.msg_id` matches.

and `ShellRouter.register` at `:540`:

```python
    def register(self, msg_id):
        """Declare interest in one request's reply. Call BEFORE sending the request."""
```

Call sites `:875` and `:934` register before the corresponding send. So the fix
is consistency with this file's own already-shipped router, not an invention.

## Region ownership (round-3 brief §2)

- P2 (me): `_send`, `call_sync`, `call_async`, `_waiters`, `_SyncWaiter` /
  `_AsyncWaiter` construction.
- P3: `CellLease.invoke`, `pending`, the accepted-call state machine.
- P4: `onCall` dispatch and the routing branch.

## Known coupling to check before renaming anything

`packages/dsh-ipython/src/v4-bridge-probe.ts:596` extracts the client's frame
fields by regex on the literal text:

```ts
const sendBody = /def _send\(self, tool, arguments\):([\s\S]*?)\n    def /.exec(clientSource)?.[1] ?? ''
```

Any change to `_send`'s SIGNATURE silently empties that extraction. Checked
separately before the edit.
