"""Probe the mechanics M3 depends on, before any TypeScript is written.

Every entry here is a thing a requirement asserts, measured on this machine so
the design rests on observation rather than on the Jupyter docs.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time

from jupyter_client import KernelManager

OUT = {}

work = tempfile.mkdtemp(prefix="m11-probe-")
kernel_out = open(os.path.join(work, "kernel.out"), "wb")
kernel_err = open(os.path.join(work, "kernel.err"), "wb")

km = KernelManager(transport_encryption="required")
km.start_kernel(stdout=kernel_out, stderr=kernel_err)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)

cf = json.loads(open(km.connection_file, encoding="utf-8").read())
OUT["connection_file"] = {
    "transport": cf.get("transport"),
    "has_curve_publickey": "curve_publickey" in cf,
    "has_curve_secretkey": "curve_secretkey" in cf,
    "has_key": bool(cf.get("key")),
    "ip": cf.get("ip"),
    "keys": sorted(cf.keys()),
}
OUT["kernel_pid"] = km.provisioner.pid if km.provisioner else None
OUT["kernelspec_interrupt_mode"] = km.kernel_spec.interrupt_mode
OUT["kernelspec_supported_encryption"] = (km.kernel_spec.metadata or {}).get("supported_encryption")


def drain_until(msg_id, timeout=30.0):
    """Collect iopub until the idle for msg_id; return (iopub, reply)."""
    iopub = []
    reply = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            msg = kc.get_iopub_msg(timeout=0.5)
        except Exception:
            msg = None
        if msg is not None:
            iopub.append(msg)
            if msg["msg_type"] == "status" and msg["content"].get("execution_state") == "idle" \
               and msg["parent_header"].get("msg_id") == msg_id:
                break
        try:
            r = kc.get_shell_msg(timeout=0.05)
            if r["parent_header"].get("msg_id") == msg_id:
                reply = r
        except Exception:
            pass
    return iopub, reply


def run(code, timeout=30.0):
    mid = kc.execute(code, allow_stdin=False)
    return drain_until(mid, timeout)


# 1. real IPython + magic + top-level await
iopub, reply = run("import sys, asyncio\nprint(type(get_ipython()).__name__)\n%time 1+1\n"
                   "async def _f():\n    return 41\nprint('await:', await _f() + 1)\n"
                   "print('shell:', sys.modules['ipykernel.zmqshell'].ZMQInteractiveShell is type(get_ipython()))")
OUT["real_ipython_and_tla"] = {
    "stdout": "".join(m["content"]["text"] for m in iopub if m["msg_type"] == "stream"),
    "reply_status": reply["content"]["status"] if reply else None,
    "error": reply["content"].get("ename") if reply and reply["content"]["status"] == "error" else None,
}

# 2. top-level await with no wrapper at all, at module level of the cell
iopub, reply = run("x = await asyncio.sleep(0.01, result=7)\nprint('tla2', x)")
OUT["top_level_await_bare"] = {
    "stdout": "".join(m["content"]["text"] for m in iopub if m["msg_type"] == "stream"),
    "reply_status": reply["content"]["status"] if reply else None,
}

# 3. stdin disabled
iopub, reply = run("input('give me')")
OUT["stdin_disabled"] = {
    "reply_status": reply["content"]["status"] if reply else None,
    "ename": reply["content"].get("ename") if reply else None,
    "evalue": (reply["content"].get("evalue") or "")[:200] if reply else None,
}

# 4. late output from a background thread AFTER the cell settles
iopub, reply = run("import threading, time\n"
                   "def _bg():\n"
                   "    time.sleep(1.2)\n"
                   "    print('LATE-FROM-THREAD')\n"
                   "threading.Thread(target=_bg, daemon=True).start()\n"
                   "print('cell-done')")
settle_iopub = iopub
late_msgs = []
deadline = time.time() + 4.0
while time.time() < deadline:
    try:
        m = kc.get_iopub_msg(timeout=0.5)
    except Exception:
        continue
    late_msgs.append({
        "msg_type": m["msg_type"],
        "parent_msg_id": m["parent_header"].get("msg_id"),
        "parent_msg_type": m["parent_header"].get("msg_type"),
        "text": m["content"].get("text", "")[:80],
        "state": m["content"].get("execution_state"),
    })
OUT["late_thread_output"] = {
    "cell_stdout": "".join(m["content"]["text"] for m in settle_iopub if m["msg_type"] == "stream"),
    "cell_msg_id": reply["parent_header"].get("msg_id") if reply else None,
    "after_settle": late_msgs,
}

# 5. kernel_info_request issued while a long cell is running -> foreign shell frame
import queue as _q
foreign = {}
mid = kc.execute("import time\ntime.sleep(2.0)\nprint('long-done')", allow_stdin=False)
time.sleep(0.6)
info_id = kc.kernel_info()
deadline = time.time() + 12
saw_info_reply = None
saw_long_reply = None
foreign_frames = []
while time.time() < deadline and (saw_info_reply is None or saw_long_reply is None):
    try:
        r = kc.get_shell_msg(timeout=0.5)
    except Exception:
        continue
    p = r["parent_header"].get("msg_id")
    if p == info_id:
        saw_info_reply = r["msg_type"]
    elif p == mid:
        saw_long_reply = r["msg_type"]
    else:
        foreign_frames.append({"msg_type": r["msg_type"], "parent": p})
    if saw_info_reply and saw_long_reply:
        break
OUT["foreign_shell_frame_while_busy"] = {
    "long_msg_id": mid,
    "kernel_info_msg_id": info_id,
    "kernel_info_reply_seen": saw_info_reply,
    "long_execute_reply_seen": saw_long_reply,
    "unexpected": foreign_frames,
    "info_reply_arrived_before_long_reply": None,
}
# drain iopub for the long cell
try:
    drain_until(mid, timeout=15)
except Exception:
    pass

# 6. interrupt a CPU loop on this platform
t0 = time.time()
mid = kc.execute("import time\nwhile True:\n    pass", allow_stdin=False)
time.sleep(1.5)
km.interrupt_kernel()
iopub, reply = drain_until(mid, timeout=20)
OUT["interrupt_cpu_loop"] = {
    "elapsed_s": round(time.time() - t0, 2),
    "reply_status": reply["content"]["status"] if reply else None,
    "ename": reply["content"].get("ename") if reply else None,
}
# reuse after interrupt
iopub, reply = run("print('reuse-ok', 6*7)")
OUT["reuse_after_interrupt"] = {
    "stdout": "".join(m["content"]["text"] for m in iopub if m["msg_type"] == "stream"),
    "reply_status": reply["content"]["status"] if reply else None,
}

# 7. interrupt an await-suspended cell
t0 = time.time()
mid = kc.execute("import asyncio\nawait asyncio.sleep(600)\nprint('never')", allow_stdin=False)
time.sleep(1.5)
km.interrupt_kernel()
iopub, reply = drain_until(mid, timeout=20)
OUT["interrupt_await_suspended"] = {
    "elapsed_s": round(time.time() - t0, 2),
    "reply_status": reply["content"]["status"] if reply else None,
    "ename": reply["content"].get("ename") if reply else None,
    "stderr": "".join(m["content"]["text"] for m in iopub if m["msg_type"] == "stream" and m["content"]["name"] == "stderr")[:300],
}

# 8. exception does not roll back the namespace
iopub, reply = run("kept = 11\nraise ValueError('boom')")
iopub2, reply2 = run("print('kept:', kept)")
OUT["exception_no_rollback"] = {
    "first_status": reply["content"]["status"] if reply else None,
    "first_ename": reply["content"].get("ename") if reply else None,
    "second_stdout": "".join(m["content"]["text"] for m in iopub2 if m["msg_type"] == "stream"),
}

kc.stop_channels()
km.shutdown_kernel(now=True)
kernel_out.close()
kernel_err.close()

with open(os.path.join(work, "kernel.err"), "rb") as fh:
    err_text = fh.read().decode("utf-8", "replace")
OUT["kernel_stderr_has_plaintext_warning"] = "without encryption" in err_text
OUT["kernel_stderr_tail"] = err_text[-800:]

print(json.dumps(OUT, indent=2))
