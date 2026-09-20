"""IPY-13 candidate-bootstrap probe: measure the design BEFORE writing it into the broker.

WHY. `EXPERIMENT.md` section 3 recommends a stream wrapper that routes a write to a
`background/undecidable` side channel when the cell ContextVar is unset. That
recommendation has a consequence the experiment did NOT measure: a thread started
from a cell has an empty context, so a cell that does `t.start(); t.join()` and
prints from the worker would have its output classified as background rather than
as its own. `threading.Thread` + `join()` is ordinary Python, and a fix that
silently removes that output from the cell result would trade a mis-attribution
defect for a missing-output defect.

This probe measures both candidate designs on a REAL kernel, through the REAL
KernelManager path, before either is written into `broker.py`:

  DESIGN 1  stream wrapper only (the experiment's recommendation, verbatim)
  DESIGN 2  stream wrapper + cell identity propagated into threads started from a
            cell, which is what `asyncio.Task` already does natively

and the arms that must stay correct in either design.

Run: python s5-ipy13-bootstrap-probe.py <out.json>
"""
import json
import os
import sys
import tempfile
import time

from jupyter_client.manager import KernelManager

OUT = sys.argv[1] if len(sys.argv) > 1 else None
WORK = tempfile.mkdtemp(prefix="s5-ipy13-boot-")

BOOTSTRAP = r'''
import contextvars, sys, threading

_dsh_cell = contextvars.ContextVar("dsh_cell_id", default=None)
_dsh_propagate = True

_DSH_BACKGROUND = {"msg_id": "dsh:background", "msg_type": "dsh-background",
                   "username": "dsh", "session": "dsh", "version": "5.3", "date": None}


def _install_stream(stream):
    original = stream.write

    def write(string):
        if _dsh_cell.get(None) is None:
            previous = stream.parent_header
            stream.set_parent(dict(_DSH_BACKGROUND))
            try:
                return original(string)
            finally:
                stream.set_parent(previous)
        return original(string)

    stream.write = write


_original_thread_start = threading.Thread.start


def _start(self, *args, **kwargs):
    cell = _dsh_cell.get(None)
    if _dsh_propagate and cell is not None:
        inner = self.run

        def run_with_cell(*a, **k):
            token = _dsh_cell.set(cell)
            try:
                return inner(*a, **k)
            finally:
                _dsh_cell.reset(token)

        self.run = run_with_cell
    return _original_thread_start(self, *args, **kwargs)


threading.Thread.start = _start


def _pre_run_cell(info):
    parent = get_ipython().kernel.get_parent()
    meta = (parent or {}).get("metadata") or {}
    _dsh_cell.set(meta.get("dsh_cell_id"))


def _post_run_cell(result):
    _dsh_cell.set(None)


_ip = get_ipython()
_ip.events.register("pre_run_cell", _pre_run_cell)
_ip.events.register("post_run_cell", _post_run_cell)
_install_stream(sys.stdout)
_install_stream(sys.stderr)
'''

boot_path = os.path.join(WORK, "dsh_bootstrap.py")
with open(boot_path, "w", encoding="utf-8") as handle:
    handle.write(BOOTSTRAP)

results = {"work_dir": WORK, "design": {}}

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
        mt = m.get("msg_type")
        entry = {"parent": parent, "own": parent == msg_id, "msg_type": mt}
        if mt == "stream":
            entry["text"] = m.get("content", {}).get("text")
            entry["stream"] = m.get("content", {}).get("name")
        elif mt in ("display_data", "execute_result"):
            entry["text"] = m.get("content", {}).get("data", {}).get("text/plain")
        elif mt == "error":
            entry["ename"] = m.get("content", {}).get("ename")
        frames.append(entry)
        if mt == "status" and m.get("content", {}).get("execution_state") == "idle" and parent == msg_id:
            break
    return {"msg_id": msg_id, "frames": frames}


def drain(seconds):
    """Frames arriving with no live cell: the post-return population."""
    out = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            m = kc.get_iopub_msg(timeout=0.4)
        except Exception:
            continue
        out.append({"parent": m.get("parent_header", {}).get("msg_id"),
                    "msg_type": m.get("msg_type"),
                    "text": m.get("content", {}).get("text"),
                    "stream": m.get("content", {}).get("name")})
    return out


# --- P0: is sys.stdout the ipykernel OutStream, and does it have set_parent? ---
results["p0_stream_type"] = run(
    "print('P0_TYPE', type(sys.stdout).__module__ + '.' + type(sys.stdout).__name__,\n"
    "      'has_set_parent', hasattr(sys.stdout, 'set_parent'),\n"
    "      'has_parent_header', hasattr(sys.stdout, 'parent_header'))",
    metadata={"dsh_cell_id": "C0"},
)

# --- P1: does a threading.Thread inherit the creating context on this Python? ---
results["p1_thread_context"] = run(
    "import threading\n"
    "res = {}\n"
    "t = threading.Thread(target=lambda: res.__setitem__('v', _dsh_cell.get(None)))\n"
    "t.start(); t.join()\n"
    "print('P1_THREAD_SEES', res['v'])\n",
    metadata={"dsh_cell_id": "C1"},
)

# --- P2: DESIGN 1's cost. A cell that joins a thread and prints from it. -------
results["p2_join_design2"] = run(
    "import threading\n"
    "def worker():\n"
    "    print('P2-WORKER-OUTPUT')\n"
    "t = threading.Thread(target=worker)\n"
    "t.start(); t.join()\n"
    "print('P2-cell-settled')\n",
    metadata={"dsh_cell_id": "C2"},
)
results["p2_join_design1"] = run(
    "_dsh_propagate = False\n"
    "import threading\n"
    "def worker2():\n"
    "    print('P2B-WORKER-OUTPUT')\n"
    "t = threading.Thread(target=worker2)\n"
    "t.start(); t.join()\n"
    "print('P2B-cell-settled')\n",
    metadata={"dsh_cell_id": "C2B"},
)

# --- P3: a genuinely empty-context writer: _thread.start_new_thread ------------
results["p3_raw_thread"] = run(
    "import _thread, time\n"
    "def raw():\n"
    "    time.sleep(0.3)\n"
    "    print('P3-RAW-THREAD-WRITE')\n"
    "_thread.start_new_thread(raw, ())\n"
    "time.sleep(1.0)\n"
    "print('P3-cell-settled')\n",
    metadata={"dsh_cell_id": "C3"},
)

# --- P4: the straddling write, DESIGN 2 (origin propagated) -------------------
results["p4_start"] = run(
    "import threading, time\n"
    "def straddler():\n"
    "    time.sleep(1.2)\n"
    "    print('P4-STRADDLER-WRITE')\n"
    "threading.Thread(target=straddler, daemon=True).start()\n"
    "print('P4-cellA-settled')\n",
    metadata={"dsh_cell_id": "CELL-A"},
)
results["p4_later"] = run(
    "import time\n"
    "for i in range(4):\n"
    "    print('p4-tick', i, flush=True)\n"
    "    time.sleep(0.5)\n"
    "print('P4-cellB-settled')\n",
    metadata={"dsh_cell_id": "CELL-B"},
)

# --- P5: the straddling write with propagation DISABLED (DESIGN 1) ------------
results["p5_start"] = run(
    "_dsh_propagate = False\n"
    "import threading, time\n"
    "def straddler2():\n"
    "    time.sleep(1.2)\n"
    "    print('P5-STRADDLER-WRITE')\n"
    "threading.Thread(target=straddler2, daemon=True).start()\n"
    "print('P5-cellA-settled')\n",
    metadata={"dsh_cell_id": "CELL-A2"},
)
results["p5_later"] = run(
    "import time\n"
    "for i in range(4):\n"
    "    print('p5-tick', i, flush=True)\n"
    "    time.sleep(0.5)\n"
    "print('P5-cellB-settled')\n",
    metadata={"dsh_cell_id": "CELL-B2"},
)

# --- P6: post_run_cell after a raising cell ----------------------------------
results["p6_error"] = run("raise ValueError('p6-boom')", metadata={"dsh_cell_id": "C6"})
results["p6_after_error"] = run(
    "import threading, time\n"
    "res = {}\n"
    "def probe():\n"
    "    res['v'] = _dsh_cell.get(None)\n"
    "t = threading.Thread(target=probe); t.start(); t.join()\n"
    "print('P6_AFTER_ERROR_CELLVAR', res['v'])\n",
    metadata={"dsh_cell_id": "C6B"},
)

# --- P7: raw fd write ----------------------------------------------------------
results["p7_raw_fd"] = run(
    "import os, time\n"
    "os.write(1, b'P7-RAW-FD-WRITE\\n')\n"
    "time.sleep(0.6)\n"
    "print('P7-cell-settled')\n",
    metadata={"dsh_cell_id": "C7"},
)

# --- P8: background display() --------------------------------------------------
results["p8_display"] = run(
    "import threading, time\n"
    "def shower():\n"
    "    time.sleep(1.2)\n"
    "    display({'text/plain': 'P8-BG-DISPLAY'})\n"
    "threading.Thread(target=shower, daemon=True).start()\n"
    "print('P8-cellA-settled')\n",
    metadata={"dsh_cell_id": "CELL-A3"},
)
results["p8_later"] = run(
    "import time\n"
    "for i in range(4):\n"
    "    print('p8-tick', i, flush=True)\n"
    "    time.sleep(0.5)\n",
    metadata={"dsh_cell_id": "CELL-B3"},
)

# --- P9: the post-return write with no later cell ------------------------------
results["p9_start"] = run(
    "import threading, time\n"
    "def later():\n"
    "    time.sleep(0.6)\n"
    "    print('P9-POSTRETURN-WRITE')\n"
    "threading.Thread(target=later, daemon=True).start()\n"
    "print('P9-cell-settled')\n",
    metadata={"dsh_cell_id": "CELL-A4"},
)
results["p9_orphan_frames"] = drain(2.0)

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(text)
