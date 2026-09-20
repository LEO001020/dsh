# IPY-13 — HOW output is attributed today, and why the straddling write rides the next cell

**Date:** 2026-09-20. **Tree:** `D:\DSH\work\wt-s5` @ `wt/s5`.
All line numbers are in THIS worktree unless prefixed with the installed
site-packages path.

---

## 1. The attribution path, with file:line

| step | where | what it does |
|---|---|---|
| 1 | `broker.py:612-622` | the broker builds the `execute_request` via `self._kc.session.msg(...)`; `msg_id = msg["header"]["msg_id"]` (`:623`) |
| 2 | `broker.py:624-626` | a `CellSink(msg_id, cap)` is created and published as `self._sink` — the accumulator for exactly one in-flight cell |
| 3 | `broker.py:488-513` | ONE IOPub pump thread owns the channel for the kernel's lifetime |
| 4 | `broker.py:518` | **the attribution decision**: `parent = msg.get("parent_header", {}).get("msg_id")` |
| 5 | `broker.py:525-527` | `if sink is not None and parent == sink.msg_id and not sink.idle_seen: sink.absorb(msg)` — this is the ONLY way a frame becomes cell output |
| 6 | `broker.py:528-531` | everything else that is a `stream` frame becomes `self._event("late_output", cellId=parent or "", text=text)` |
| 7 | `broker.py:668-669` | at the end of `execute`, `self._sink = None` — the sink is withdrawn the moment the cell settles |

So a frame is attributed to a cell **iff its `parent_header.msg_id` equals the
live cell's request `msg_id`**. Nothing else is consulted.

## 2. Where the straddling write gets the wrong parent — in the KERNEL

`parent_header` is not a broker-side guess; it is stamped by ipykernel at write
time. The chain, in the installed ipykernel **7.3.0**
(`C:/Users/hzq00/AppData/Local/Programs/Python/Python314/Lib/site-packages/ipykernel/`):

- `iostream.py:541-544` — each `OutStream` owns
  `self._parent_header: contextvars.ContextVar` plus `self._parent_header_global = {}`.
- `iostream.py:596-603` — the `parent_header` property is
  ```
  try:    return self._parent_header.get()   # asyncio or thread-specific
  except LookupError: return self._parent_header_global   # global (fallback)
  ```
- `iostream.py:745` — `write()` begins with `parent = self.parent_header`.
- `iostream.py:765` — the write is buffered under `frozenset(parent.items())`,
  so **the parent is chosen per write, not per frame type**.
- `zmqshell.py:723-737` — `IPythonKernel.set_parent` calls
  `sys.stdout.set_parent(parent)` / `sys.stderr.set_parent(parent)` for each
  incoming request.
- `iostream.py:605-608` — the property **setter** writes BOTH
  `self._parent_header_global = value` (process-wide) and
  `self._parent_header.set(value)` (the calling thread's context).

**Therefore:** `threading.Thread` starts with an EMPTY `contextvars` context, so
a background writer's `_parent_header.get()` raises `LookupError` and it takes
the **global** fallback — which `set_parent` has just overwritten with the most
recent cell's header. The kernel itself stamps the straddling write with the
LATER cell's `msg_id`, before any frame is sent.

**Consequence:** step 5 above is *satisfied* by the straddling frame, so the
broker absorbs it into the later cell. The broker is behaving correctly on the
information it has; the distinction was destroyed upstream of it. This is why no
frame-level check can fix IPY-13 — which the R8 experiment stated and this
section now pins to file:line.

## 3. THE DECISIVE MEASUREMENT: ipykernel's own ContextVar IS a usable gate

`qualification/results/S5-ipy13/s5-ipy13-gate-probe.py` (bare `KernelManager`,
real kernel, instrumented `sys.stdout`/`sys.stderr`; raw output in
`s5-ipy13-gate-probe.json`). For every write it recorded whether
`stream._parent_header.get()` **succeeded or raised**:

| arm | writer | `ipykernel_contextvar_set` |
|---|---|---|
| G1 | the cell's own `print` (stdout and stderr) | **true** |
| G2 | a `threading.Thread` joined by its own cell | **false** |
| G3 | the STRADDLER: thread from cell A writing during cell B | **false** |
| G4 | a raw `_thread.start_new_thread` writer | **false** |

The cell's own writes take the ContextVar branch; **every** out-of-thread write
falls back to the global. This is a decidable, upstream-provided discriminator —
it is the mechanism `iostream.py:596-603` already implements, not one invented
here.

**It is not sufficient on its own.** G2 (thread + `join()` inside one cell) also
reads `false`, yet that output IS the cell's own: the cell is still running and
blocked on it. `bootstrap-probe.json` P2 measures the cost of gating on the
ContextVar alone — the worker's `print` is reclassified as background and
disappears from the cell result. Gating on "contextvar unset" would trade a
mis-attribution defect for a **missing-output** defect on ordinary
`t.start(); t.join()` code. Any implementation must keep G2 in the cell while
moving G3 out.

## 4. What is available to carry cell identity (pinned source, verified)

- `jupyter_client/provisioning/local_provisioner.py:210,247,250-251` — `start_kernel`
  pops `extra_arguments` and appends it to the kernelspec argv. **Public kwarg.**
- `IPython/core/shellapp.py:189` — `exec_files = List(Unicode(), ...).tag(config=True)`,
  run at startup by `_run_exec_files` (`:446-456`). **Public config trait.**
- `jupyter_client/session.py:655-677` — `Session.msg(msg_type, content, parent,
  header, metadata)` merges the caller's `metadata` into the outgoing message, so
  `execute_request.metadata` is a first-class, public carrier.
- `ipykernel/kernelbase.py:694-733` — `get_parent()` / `_get_shell_context_var`;
  `kernelbase.py:219-226` — the `_parent_header` property is DEPRECATED in
  ipykernel 6 (it emits a `DeprecationWarning` naming `.get_parent()`), so the
  bootstrap must not use it.

`mechanism-probe.json` (already on disk, from the bare-kernel probe) measures
that all three work together: the bootstrap loads via `exec_files`, the metadata
reaches `pre_run_cell`, and a sentinel parent header reaches the broker as a
frame whose `parent_header.msg_id` is the sentinel.
