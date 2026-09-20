"""IPY-13 gate probe: WHICH signal can distinguish a cell's own write from a
background thread's write?

THE QUESTION. `ipykernel/iostream.py:596-608` resolves `OutStream.parent_header`
as `self._parent_header.get()` (a ContextVar) with a fallback to
`self._parent_header_global`. `write()` at `iostream.py:745` reads that property.
So a write is "provably in a cell context" iff the ContextVar lookup SUCCEEDS,
and it is "the most recent cell by fallback" iff it raises LookupError.

That distinction is only useful as a gate if the CELL'S OWN writes take the
ContextVar branch. If a cell body's own print also falls back to the global, the
gate would misfire on every ordinary cell and be worse than useless.

So this probe instruments `sys.stdout.write` / `sys.stderr.write` and records,
for EVERY write, whether `_parent_header.get()` raised -- in the cell's own
thread, in a `threading.Thread`, and in a raw `_thread.start_new_thread`.

It also records what the DSH-metadata alternative would see (a separate
ContextVar set in `pre_run_cell`), so the two candidate gates are compared on the
same run rather than argued about.

Run: python s5-ipy13-gate-probe.py <out.json>
"""
import json
import os
import sys
import tempfile
import time

from jupyter_client.manager import KernelManager

OUT = sys.argv[1] if len(sys.argv) > 1 else None
WORK = tempfile.mkdtemp(prefix="s5-ipy13-gate-")

BOOTSTRAP = r'''
import contextvars, sys

# The DSH candidate: our own cell id, set from execute_request.metadata.
_dsh_cell = contextvars.ContextVar("dsh_cell_id", default=None)
_trace = []


def _install(stream, name):
    original = stream.write

    def write(string):
        # 1. Does ipykernel's OWN contextvar resolve, or would it fall back to
        #    the global that holds the most recent cell?
        try:
            ipy = stream._parent_header.get()
            ctx_ok = True
        except LookupError:
            ipy = None
            ctx_ok = False
        # 2. What would the DSH-metadata gate see?
        dsh = _dsh_cell.get(None)
        if isinstance(string, str) and string.strip():
            _trace.append({
                "stream": name,
                "text": string,
                "ipykernel_contextvar_set": ctx_ok,
                "ipykernel_parent": (ipy or {}).get("msg_id") if ctx_ok else None,
                "parent_header_property": (stream.parent_header or {}).get("msg_id"),
                "dsh_cell": dsh,
                "thread": __import__("threading").current_thread().name,
            })
        return original(string)

    stream.write = write


_install(sys.stdout, "stdout")
_install(sys.stderr, "stderr")


def _pre_run_cell(info):
    try:
        parent = get_ipython().kernel.get_parent()
    except Exception:
        parent = None
    _dsh_cell.set(((parent or {}).get("metadata") or {}).get("dsh_cell_id"))


def _post_run_cell(result):
    _dsh_cell.set(None)


_ip = get_ipython()
_ip.events.register("pre_run_cell", _pre_run_cell)
_ip.events.register("post_run_cell", _post_run_cell)
'''

boot_path = os.path.join(WORK, "dsh_gate_bootstrap.py")
with open(boot_path, "w", encoding="utf-8") as handle:
    handle.write(BOOTSTRAP)

results = {"work_dir": WORK}
km = KernelManager(transport_encryption="required")
km.start_kernel(
    stdout=open(os.path.join(WORK, "kernel.out"), "wb"),
    stderr=open(os.path.join(WORK, "kernel.err"), "wb"),
    extra_arguments=["--IPKernelApp.exec_files=" + json.dumps([boot_path])],
)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)


def run(code, metadata=None, timeout=40):
    content = {"code": code, "silent": False, "store_history": True,
               "user_expressions": {}, "allow_stdin": False, "stop_on_error": True}
    msg = kc.session.msg("execute_request", content, metadata=dict(metadata or {}))
    kc.shell_channel.send(msg)
    msg_id = msg["header"]["msg_id"]
    frames = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            m = kc.get_iopub_msg(timeout=0.5)
        except Exception:
            continue
        parent = m.get("parent_header", {}).get("msg_id")
        entry = {"parent": parent, "own": parent == msg_id, "msg_type": m.get("msg_type")}
        if m.get("msg_type") == "stream":
            entry["text"] = m.get("content", {}).get("text")
        frames.append(entry)
        if m.get("msg_type") == "status" and m.get("content", {}).get("execution_state") == "idle" \
                and parent == msg_id:
            break
    return {"msg_id": msg_id, "frames": frames}


def dump_trace(label):
    """Read the kernel-side trace back out through a cell (no side channel)."""
    out = run("import json as _j; print('TRACE', _j.dumps(_trace))",
              metadata={"dsh_cell_id": "trace-reader"})
    text = "".join(f.get("text", "") for f in out["frames"] if f.get("msg_type") == "stream")
    start = text.find("TRACE ")
    if start < 0:
        return {"error": "no trace in %r" % text[:200]}
    payload = text[start + 6:].strip()
    entries = json.loads(payload)
    _ = run("_trace.clear()")
    return entries


# --- G1: the CELL'S OWN writes. THE DECISIVE ARM. ----------------------------
results["g1_cell_own_writes"] = run(
    "print('G1-CELL-PRINT')\n"
    "import sys; print('G1-CELL-ERR', file=sys.stderr)\n",
    metadata={"dsh_cell_id": "CELL-G1"},
)
results["g1_trace"] = dump_trace("g1")

# --- G2: a threading.Thread writing WHILE ITS OWN CELL IS STILL RUNNING ------
results["g2_join"] = run(
    "import threading\n"
    "def worker():\n"
    "    print('G2-WORKER-OUTPUT')\n"
    "t = threading.Thread(target=worker)\n"
    "t.start(); t.join()\n"
    "print('G2-cell-settled')\n",
    metadata={"dsh_cell_id": "CELL-G2"},
)
results["g2_trace"] = dump_trace("g2")

# --- G3: the STRADDLER -- starts in cell A, writes during cell B ------------
results["g3_cellA"] = run(
    "import threading, time\n"
    "def straddler():\n"
    "    time.sleep(1.2)\n"
    "    print('G3-STRADDLER-WRITE')\n"
    "threading.Thread(target=straddler, daemon=True).start()\n"
    "print('G3-cellA-settled')\n",
    metadata={"dsh_cell_id": "CELL-A"},
)
results["g3_cellB"] = run(
    "import time\n"
    "for i in range(4):\n"
    "    print('g3-tick', i, flush=True)\n"
    "    time.sleep(0.5)\n"
    "print('G3-cellB-settled')\n",
    metadata={"dsh_cell_id": "CELL-B"},
)
results["g3_trace"] = dump_trace("g3")

# --- G4: a raw _thread writer (empty context, unreachable by any propagation) -
results["g4_raw"] = run(
    "import _thread, time\n"
    "def raw():\n"
    "    time.sleep(0.4)\n"
    "    print('G4-RAW-THREAD-WRITE')\n"
    "_thread.start_new_thread(raw, ())\n"
    "time.sleep(1.2)\n"
    "print('G4-cell-settled')\n",
    metadata={"dsh_cell_id": "CELL-G4"},
)
results["g4_trace"] = dump_trace("g4")

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(text)
