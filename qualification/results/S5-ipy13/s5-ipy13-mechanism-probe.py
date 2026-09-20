"""IPY-13 mechanism probe: can a DSH-injected bootstrap carry cell identity, and
does the sentinel-parent routing actually reach the broker as a distinct frame?

WHY THIS EXISTS. The R8 experiment established the mechanism in a bare kernel and
explicitly did NOT measure it through this project's path ("Not measured through
DSH: no broker, no kernel service, no profile"). This probe measures the two
things the implementation depends on, in THIS tree, before any production code
changes:

  Q1. Can the broker inject a bootstrap into the kernel through
      `KernelManager.start_kernel(extra_arguments=[...])` -- i.e. is
      `--IPKernelApp.exec_files=` accepted and executed at kernel startup?
      (jupyter_client/provisioning/local_provisioner.py:210,247,250-251 pops
      `extra_arguments` and appends it to the kernelspec argv.)

  Q2. Does `execute_request.metadata` reach the bootstrap's `pre_run_cell`
      handler, so a DSH cell id can be carried without touching user code?

  Q3. Does a `threading.Thread` (empty context) MISS the ContextVar, and does
      routing its write to a sentinel parent header actually produce a frame
      whose `parent_header.msg_id` is the sentinel -- i.e. a frame the broker's
      existing `_route_iopub` already classifies as NOT this cell?

  Q4. Do the semantic traps survive (top-level await, magic, traceback,
      displayhook)?

Run: python s5-ipy13-mechanism-probe.py <out.json>
"""
import json
import os
import sys
import tempfile
import time

from jupyter_client.manager import KernelManager

OUT = sys.argv[1] if len(sys.argv) > 1 else None
WORK = tempfile.mkdtemp(prefix="s5-ipy13-probe-")

BOOTSTRAP = r'''
import contextvars, sys

_dsh_cell = contextvars.ContextVar("dsh_cell_id", default=None)
_DSH_BACKGROUND = {"msg_id": "dsh:background", "msg_type": "dsh-background",
                   "username": "dsh", "session": "dsh", "version": "5.3", "date": None}


def _install_stream(stream):
    original = stream.write

    def write(string):
        if _dsh_cell.get(None) is None:
            token = stream._parent_header.set(dict(_DSH_BACKGROUND))
            try:
                return original(string)
            finally:
                stream._parent_header.reset(token)
        return original(string)

    stream.write = write


def _pre_run_cell(info):
    try:
        parent = get_ipython().kernel.get_parent()
    except Exception:
        parent = None
    meta = (parent or {}).get("metadata") or {}
    _dsh_cell.set(meta.get("dsh_cell_id"))


def _post_run_cell(result):
    _dsh_cell.set(None)


_ip = get_ipython()
_ip.events.register("pre_run_cell", _pre_run_cell)
_ip.events.register("post_run_cell", _post_run_cell)
_install_stream(sys.stdout)
_install_stream(sys.stderr)
print("DSH_BOOTSTRAP_LOADED")
'''

boot_path = os.path.join(WORK, "dsh_bootstrap.py")
with open(boot_path, "w", encoding="utf-8") as handle:
    handle.write(BOOTSTRAP)

results = {}
results["work_dir"] = WORK
results["bootstrap_path"] = boot_path

km = KernelManager(transport_encryption="required")
try:
    km.start_kernel(
        stdout=open(os.path.join(WORK, "kernel.out"), "wb"),
        stderr=open(os.path.join(WORK, "kernel.err"), "wb"),
        extra_arguments=["--IPKernelApp.exec_files=" + json.dumps([boot_path])],
    )
    results["start_kernel_accepted_extra_arguments"] = True
except Exception as exc:
    results["start_kernel_accepted_extra_arguments"] = False
    results["start_kernel_error"] = "%s: %s" % (type(exc).__name__, exc)
    print(json.dumps(results, indent=1, default=str))
    sys.exit(1)

kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)


def run(code, metadata=None, timeout=30, label=""):
    content = {"code": code, "silent": False, "store_history": True,
               "user_expressions": {}, "allow_stdin": False, "stop_on_error": True}
    msg = kc.session.msg("execute_request", content, metadata=dict(metadata or {}))
    kc.shell_channel.send(msg)
    msg_id = msg["header"]["msg_id"]
    out = []
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
        elif mt == "execute_result":
            entry["text"] = m.get("content", {}).get("data", {}).get("text/plain")
        elif mt == "error":
            entry["ename"] = m.get("content", {}).get("ename")
        out.append(entry)
        if mt == "status" and m.get("content", {}).get("execution_state") == "idle" and parent == msg_id:
            break
    return {"msg_id": msg_id, "frames": out}


# Q1: did the bootstrap run at kernel startup?
results["q1_bootstrap_ran"] = run("print('probe-alive')", label="q1")

# Q2: does metadata reach pre_run_cell, and is the contextvar set for the cell?
results["q2_metadata"] = run(
    "print('Q2_CTXVAR', _dsh_cell.get())",
    metadata={"dsh_cell_id": "CELL-A"},
    label="q2",
)

# Q2b: NO metadata -> must be None, never the previous cell's id.
results["q2b_no_metadata"] = run("print('Q2B_CTXVAR', _dsh_cell.get())", label="q2b")

# Q3: a plain thread (empty context) writes AFTER this cell returns, while the
# NEXT cell is running. The write must carry the SENTINEL parent, not the live
# cell's msg_id.
results["q3_start_thread"] = run(
    "import threading, time\n"
    "def straddler():\n"
    "    time.sleep(1.2)\n"
    "    print('Q3-STRADDLER-WRITE')\n"
    "threading.Thread(target=straddler, daemon=True).start()\n"
    "print('Q3-cellA-settled')\n",
    metadata={"dsh_cell_id": "CELL-A"},
    label="q3a",
)
results["q3_later_cell"] = run(
    "import time\n"
    "for i in range(4):\n"
    "    print('q3-tick', i, flush=True)\n"
    "    time.sleep(0.5)\n"
    "print('Q3-cellB-settled')\n",
    metadata={"dsh_cell_id": "CELL-B"},
    label="q3b",
)

# Q3c: a thread created with an EXPLICIT copy of the cell's context DOES inherit
# the id -- the oracle's other direction, recorded so the policy is explicit.
results["q3c_context_copy_thread"] = run(
    "import threading, contextvars\n"
    "res = {}\n"
    "def copier():\n"
    "    res['v'] = _dsh_cell.get()\n"
    "t = threading.Thread(target=contextvars.copy_context().run, args=(copier,))\n"
    "t.start(); t.join()\n"
    "print('Q3C_COPY_CONTEXT', res['v'])\n",
    metadata={"dsh_cell_id": "CELL-C"},
    label="q3c",
)

# Q4: the semantic traps.
results["q4_await"] = run("import asyncio\nawait asyncio.sleep(0.01)\nprint('AWAIT_OK')", label="q4a")
results["q4_magic"] = run("%who\nprint('MAGIC_OK')", label="q4b")
results["q4_traceback"] = run("def f():\n    raise ValueError('boom')\nf()", label="q4c")
results["q4_displayhook"] = run("1 + 1", label="q4d")

# Q5: stderr from a background thread -- same path?
results["q5_stderr"] = run(
    "import sys, threading, time\n"
    "def later():\n"
    "    time.sleep(0.5)\n"
    "    print('Q5-BG-STDERR', file=sys.stderr)\n"
    "threading.Thread(target=later, daemon=True).start()\n",
    metadata={"dsh_cell_id": "CELL-D"},
    label="q5",
)
time.sleep(1.5)
try:
    m = kc.get_iopub_msg(timeout=2.0)
    results["q5_late_frame"] = {
        "parent": m.get("parent_header", {}).get("msg_id"),
        "msg_type": m.get("msg_type"),
        "text": m.get("content", {}).get("text"),
        "stream": m.get("content", {}).get("name"),
    }
except Exception as exc:
    results["q5_late_frame"] = "no frame: %s" % exc

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(text)
