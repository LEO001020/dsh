"""IPY-13 AFTER probe: does the generated bootstrap change the frames?

Runs the SAME stimulus as `s5-ipy13-before.ts`, but against a bare
`KernelManager` so the bootstrap can be exercised in isolation from the broker,
and records every raw IOPub frame. Then it reads the broker's own marker back.

Arms (each is an oracle clause or a control):
  A  post-return write, no later cell      -> must be late
  B  STRADDLER: cell A's thread writes during cell B
                                            -> must NOT be in cell B
  C  ordinary in-cell print                -> must stay in the cell (control)
  D  thread + join() INSIDE one cell       -> must STAY in that cell (control:
                                              this is what a naive
                                              "contextvar unset => background"
                                              gate would break)
  E  raw _thread.start_new_thread writer   -> undecidable, not attributed
  F  top-level await / magic / traceback / displayhook -> semantics survive

Run: python s5-ipy13-after-probe.py <out.json>
"""
import importlib.util
import json
import os
import sys
import tempfile
import time

from jupyter_client.manager import KernelManager

HERE = os.path.dirname(os.path.abspath(__file__))
BROKER_PATH = os.path.abspath(os.path.join(HERE, "..", "..", "..", "packages", "dsh-ipython", "src", "broker.py"))

spec = importlib.util.spec_from_file_location("dsh_broker", BROKER_PATH)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

OUT = sys.argv[1] if len(sys.argv) > 1 else None
WORK = tempfile.mkdtemp(prefix="s5-ipy13-after-")

boot_path, marker_path = broker.write_attribution_bootstrap(WORK)

results = {"work_dir": WORK, "bootstrap_path": boot_path, "marker_path": marker_path}

km = KernelManager(transport_encryption="required")
km.start_kernel(
    stdout=open(os.path.join(WORK, "kernel.out"), "wb"),
    stderr=open(os.path.join(WORK, "kernel.err"), "wb"),
    extra_arguments=["--IPKernelApp.exec_files=" + json.dumps([boot_path])],
)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)


def run(code, timeout=40):
    content = {"code": code, "silent": False, "store_history": True,
               "user_expressions": {}, "allow_stdin": False, "stop_on_error": True}
    msg = kc.session.msg("execute_request", content)
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
            entry["stream"] = m.get("content", {}).get("name")
        elif m.get("msg_type") in ("display_data", "execute_result"):
            entry["text"] = m.get("content", {}).get("data", {}).get("text/plain")
        elif m.get("msg_type") == "error":
            entry["ename"] = m.get("content", {}).get("ename")
        frames.append(entry)
        if m.get("msg_type") == "status" and m.get("content", {}).get("execution_state") == "idle" \
                and parent == msg_id:
            break
    return {"msg_id": msg_id, "frames": frames}


def own_text(cell):
    return "".join(f.get("text", "") for f in cell["frames"]
                   if f.get("msg_type") == "stream" and f.get("own"))


def foreign(cell):
    return [f for f in cell["frames"] if not f.get("own")]


def drain(seconds):
    out = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            m = kc.get_iopub_msg(timeout=0.4)
        except Exception:
            continue
        out.append({"parent": m.get("parent_header", {}).get("msg_id"),
                    "msg_type": m.get("msg_type"),
                    "text": m.get("content", {}).get("text")})
    return out


# --- marker: did the bootstrap load? ----------------------------------------
results["marker_exists_after_start"] = os.path.exists(marker_path)

# --- A: post-return write, no later cell ------------------------------------
a = run("import threading, time\n"
        "def later():\n"
        "    time.sleep(0.7)\n"
        "    print('AFTER-A-POSTRETURN')\n"
        "threading.Thread(target=later, daemon=True).start()\n"
        "print('A-cell-settled')\n")
results["armA_cell"] = a
results["armA_own_text"] = own_text(a)
results["armA_foreign"] = foreign(a)
results["armA_orphans"] = drain(2.0)

# --- B: THE STRADDLER -------------------------------------------------------
b1 = run("import threading, time\n"
         "def straddler():\n"
         "    time.sleep(1.2)\n"
         "    print('AFTER-B-STRADDLER')\n"
         "threading.Thread(target=straddler, daemon=True).start()\n"
         "print('B-cellA-settled')\n")
results["armB_cellA"] = b1
results["armB_cellA_own_text"] = own_text(b1)

b2 = run("import time\n"
         "for i in range(5):\n"
         "    print('b-tick', i, flush=True)\n"
         "    time.sleep(0.4)\n"
         "print('B-cellB-settled')\n")
results["armB_cellB"] = b2
results["armB_cellB_own_text"] = own_text(b2)
results["armB_cellB_foreign"] = foreign(b2)
results["armB_straddler_rides_cellB"] = "AFTER-B-STRADDLER" in own_text(b2)

# --- C: control, ordinary in-cell output ------------------------------------
c = run("print('AFTER-C-CONTROL')")
results["armC_cell"] = c
results["armC_own_text"] = own_text(c)

# --- D: control, thread + join INSIDE one cell ------------------------------
d = run("import threading\n"
        "def worker():\n"
        "    print('AFTER-D-JOINED-WORKER')\n"
        "t = threading.Thread(target=worker)\n"
        "t.start(); t.join()\n"
        "print('D-cell-settled')\n")
results["armD_cell"] = d
results["armD_own_text"] = own_text(d)
results["armD_foreign"] = foreign(d)

# --- E: raw _thread writer ---------------------------------------------------
e = run("import _thread, time\n"
        "def raw():\n"
        "    time.sleep(0.4)\n"
        "    print('AFTER-E-RAW-THREAD')\n"
        "_thread.start_new_thread(raw, ())\n"
        "time.sleep(1.2)\n"
        "print('E-cell-settled')\n")
results["armE_cell"] = e
results["armE_own_text"] = own_text(e)
results["armE_foreign"] = foreign(e)

# --- F: semantics survive ----------------------------------------------------
results["armF_await"] = run("import asyncio\nawait asyncio.sleep(0.01)\nprint('F-AWAIT-OK')")
results["armF_magic"] = run("%who\nprint('F-MAGIC-OK')")
results["armF_error"] = run("def f():\n    raise ValueError('boom')\nf()")
results["armF_displayhook"] = run("1 + 1")

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(json.dumps({
    "marker_exists_after_start": results["marker_exists_after_start"],
    "armA_own_text": results["armA_own_text"],
    "armA_foreign_parents": [f.get("parent") for f in results["armA_foreign"]],
    "armA_orphans": results["armA_orphans"],
    "armB_straddler_rides_cellB": results["armB_straddler_rides_cellB"],
    "armB_cellB_own_text": results["armB_cellB_own_text"],
    "armB_cellB_foreign": results["armB_cellB_foreign"],
    "armC_own_text": results["armC_own_text"],
    "armD_own_text": results["armD_own_text"],
    "armD_foreign": results["armD_foreign"],
    "armE_own_text": results["armE_own_text"],
    "armE_foreign": results["armE_foreign"],
}, indent=1))
