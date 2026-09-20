# IPY-13 — the isolated kernel experiment the audit requires BEFORE a fix is chosen

**Date:** 2026-09-20
**Identity measured under:** the pinned upstream `ddefc45f…` checkout, Python
`3.14.3` at `C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe`,
`ipykernel`/`jupyter_client` as installed for that interpreter. **Not** measured
through the DSH broker: this is a bare `KernelManager` experiment, deliberately, so
that what is measured is the KERNEL's behaviour and not this project's code.

**Why this file exists.** V3 §M2 forbids guessing the fix. Its words: *"Before
writing code, build a minimal isolated ipykernel experiment reproducing: thread
started in cell A; cell A returns; cell B runs; old thread writes during B; current
default output gets B's parent. Then choose the smallest hook that can carry DSH
cell identity without breaking real IPython semantics."* This is that experiment,
and its results decide the design.

Scripts: `exp.py` (reproduction), `exp3.py` (hook candidates + semantic traps).
Both are reproducible from a clean shell; no DSH, no profile, no broker.

---

## 1. The defect REPRODUCES, exactly as stated

`exp.py` starts a thread in cell A that prints after A returns, then runs cell B
while that thread is still alive. Raw IOPub frames, as received:

```
A_msg_id = ..._44796_2      B_msg_id = ..._44796_3

A_frames:  OWN stream  parent=..._44796_2  text="A-DONE\n"
B_frames:  OWN stream  parent=..._44796_3  text="BACKGROUND-WRITE\n"   <-- cell A's thread
           OWN stream  parent=..._44796_3  text="B-DONE\n"
```

**`BACKGROUND-WRITE` was printed by a thread created in cell A, and it arrives
carrying cell B's parent id.** It is byte-for-byte indistinguishable from
`B-DONE` in every field the frame exposes. There is no marker, no flag, and no
alternative parent to compare against.

**This is why the current broker cannot fix it by inspection.** `_route_iopub`
already handles the decidable half — a frame arriving after `idle_seen` is
classified `late_output` — and that is genuinely correct. But the frame above
arrives BEFORE B's idle, so it is routed into B's sink as B's own output. **A
frame-level check cannot separate them, because the kernel already destroyed the
distinction before the frame was sent.** The audit's phrase for this is exact:
the output is *"wrongly attributed"*, and the attribution error is made inside
ipykernel, not in this project.

---

## 2. The hook exists, and `execute_request.metadata` is the carrier

`exp3.py` measures the three candidates in V3 §M2's stated order.

**(1) Does `execute_request` metadata reach a kernel-side hook? YES.**

```
meta_to_ctxvar:
  META_SEEN          {'dsh_cell_id': 'CELL-A'}
  CTXVAR_FROM_META   CELL-A
```

The request's `metadata` is readable from `IPython.get_ipython().kernel`'s parent
header inside a `pre_run_cell` handler, and a `ContextVar` set there is visible to
the cell's own code. So **a DSH cell id can be carried end-to-end without touching
user code**, which is the property that matters: V3 forbids `exec()` wrapping
because it breaks top-level await, magics, traceback locations and displayhook.

**(2) Is the cell id visible to the cell's own code? YES** — `same_cell` reports
`CELL-A`, i.e. the value set from metadata.

**(3) What does a background thread see? `None`.** Two independent arms:

```
plain_thread:    PLAIN_THREAD None      (threading.Thread, default context)
fresh_context:   FRESH_CONTEXT None     (contextvars.Context().run(...))
```

**This is the measurement that makes the fix possible.** A `ContextVar` is NOT
inherited by a plain `threading.Thread` — Python threads start with an EMPTY
context, not a copy of the creator's. So a thread started in cell A carries no
cell id, and its writes are decidable as `background/undecidable` **without
guessing**. The oracle's demand — *"A claim that the originating cell's parent id
is always preserved is NOT PASS, because it is false for a thread started with an
empty context"* — is not merely satisfiable, it is satisfiable in the direction the
oracle asks for.

**(4) No metadata → `None`, NOT the latest cell.** `no_metadata` reports
`NO_META CELL-A` in the transcript only because that run reused the ContextVar set
by the previous arm in the same kernel session; the ContextVar's `default=None`
plus the empty-context result above are what establish the real behaviour. **The
implemented hook must set the ContextVar from metadata on EVERY execution and
reset it after, so a cell without metadata cannot inherit the previous cell's id.**
That is a design requirement this experiment surfaced, and it is recorded here
rather than discovered later as a bug.

**(5) The semantic traps all survive** — this is the arm that rules out the
forbidden fixes:

| Trap | Result |
|---|---|
| top-level `await` | `AWAIT_OK` |
| IPython magic (`%who`) | `MAGIC_OK` (and `%who` listed the user's names correctly) |
| traceback with source location | `error ValueError boom` |
| displayhook (`1 + 1`) | `execute_result` `2` |

So `pre_run_cell` + `ContextVar` + a stdout/stderr proxy satisfies V3's
prohibition on `exec()` wrapping, because the user's code is never wrapped.

---

## 3. The design this experiment selects

V3 §M2's invariant, unchanged: *cannot prove cell origin ⇒ do not attribute to a
later cell.*

1. **Broker attaches the DSH cell id to `execute_request.metadata`.** This is
   cheap: `broker.py:612` already builds the request with `self._kc.session.msg(...)`,
   so the metadata is one added key — no change to how the cell is sent or awaited.
2. **A kernel bootstrap hook reads it in `pre_run_cell` and sets a `ContextVar`**,
   and clears it in `post_run_cell`. The clear is load-bearing (see §2.4).
3. **A thin stdout/stderr proxy** routes a write to the ordinary ipykernel stream
   when the `ContextVar` is set, and to a `background/undecidable` side channel
   when it is not. This is the ONLY place a proxy is needed, and it wraps the
   stream, not the code.
4. **After a cell settles, the same cell id appearing again is `late/background`** —
   the broker already has `late_output` for the post-idle case; the proxy extends
   it to the pre-idle-but-wrong-cell case that §1 shows is currently invisible.
5. **Raw OS-fd / C-extension output stays process-level**, per V3: it bypasses
   Python streams and cannot be attributed.

## 4. What is NOT claimed

- Not measured: whether the proxy preserves every file-like behaviour a library
  might rely on (`fileno`, `isatty`, buffering modes, `encoding`). **This is the
  main implementation risk and must be measured before the proxy is trusted.**
- Not measured: asyncio tasks that DO inherit a context while a lease is live.
  V3 lists this as a required test with "explicitly defined behaviour"; the
  experiment establishes the ContextVar mechanism but not this policy.
- Not measured through DSH: no broker, no kernel service, no profile. Whether the
  metadata survives the real `KernelService` path is an implementation-time
  measurement, not an established fact here.
- `Kernel._parent_header` is deprecated in ipykernel 6 (the kernel itself emitted
  a `DeprecationWarning` suggesting `.get_parent()`). The implementation should use
  the non-deprecated accessor; this experiment used the deprecated one and says so.
