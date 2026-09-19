"""Probe the interrupt routes and reset paths, on this platform.

M0 measured that interrupt of a CPU loop works. This probe asks the questions
requirement 8 actually turns on: which routes exist, which of them can be shown
to work, and what happens to a kernel that cannot be brought back.
"""
import json
import os
import signal
import subprocess
import tempfile
import time

from jupyter_client import KernelManager

RESULTS = {}


class Kernel:
    def __init__(self, **kw):
        self.dir = tempfile.mkdtemp(prefix="m11-ip-")
        self.out = open(os.path.join(self.dir, "k.out"), "wb")
        self.err = open(os.path.join(self.dir, "k.err"), "wb")
        self.km = KernelManager(**kw)
        self.km.start_kernel(stdout=self.out, stderr=self.err)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=60)
        self.pid = self.km.provisioner.pid if self.km.provisioner else None

    def execute(self, code):
        return self.kc.execute(code, allow_stdin=False)

    def drain(self, msg_id, timeout):
        iopub, reply, foreign = [], None, []
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                m = self.kc.get_iopub_msg(timeout=0.25)
            except Exception:
                m = None
            if m is not None:
                p = m["parent_header"].get("msg_id")
                (iopub if p == msg_id else foreign).append(m)
                if p == msg_id and m["msg_type"] == "status" and m["content"].get("execution_state") == "idle":
                    pass
            try:
                r = self.kc.get_shell_msg(timeout=0.05)
            except Exception:
                r = None
            if r is not None:
                p = r["parent_header"].get("msg_id")
                if p == msg_id:
                    reply = r
                else:
                    foreign.append(r)
            if reply is not None and any(
                x["msg_type"] == "status" and x["content"].get("execution_state") == "idle" for x in iopub
            ):
                break
        return iopub, reply, foreign

    def close(self):
        try:
            self.kc.stop_channels()
        except Exception:
            pass
        try:
            self.km.shutdown_kernel(now=True)
        except Exception:
            pass
        self.out.close()
        self.err.close()


# --- 1. control-channel interrupt (interrupt_mode='message') on Windows -------
k = Kernel(transport_encryption="required", kernel_name="python3")
try:
    # Force the message-based interrupt route by hand: send interrupt_request on
    # the control channel while a CPU loop runs.
    mid = k.execute("while True:\n    pass")
    time.sleep(1.5)
    t0 = time.time()
    ctrl = k.km.connect_control()
    ctrl.send(k.km.session.msg("interrupt_request", content={}))
    got = None
    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            got = ctrl.recv(timeout=500)
            break
        except Exception:
            continue
    iopub, reply, _ = k.drain(mid, timeout=10)
    RESULTS["control_channel_interrupt_request"] = {
        "interrupt_reply": got["content"] if got else None,
        "seconds": round(time.time() - t0, 2),
        "settled": reply is not None,
        "status": reply["content"]["status"] if reply else None,
        "ename": reply["content"].get("ename") if reply else None,
    }
    RESULTS["control_channel_interrupt_request"]["kernel_stderr"] = open(
        os.path.join(k.dir, "k.err"), "rb"
    ).read().decode("utf-8", "replace")[-500:]
finally:
    k.close()

# --- 2. can a wedged kernel be force-killed and is the process gone? ---------
k = Kernel(transport_encryption="required")
try:
    pid = k.pid
    mid = k.execute("import asyncio\nawait asyncio.sleep(600)")
    time.sleep(1.5)
    k.km.interrupt_kernel()
    time.sleep(2.0)
    iopub, reply, _ = k.drain(mid, timeout=3)
    wedged = reply is None
    t0 = time.time()
    killed = False
    try:
        k.km.shutdown_kernel(now=True)
        killed = True
    except Exception as exc:  # noqa: BLE001
        RESULTS.setdefault("shutdown_wedged_error", repr(exc)[:300])
    time.sleep(1.0)
    probe = subprocess.run(
        ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
        capture_output=True, text=True, check=False,
    )
    RESULTS["reset_wedged_kernel"] = {
        "wedged": wedged,
        "shutdown_now_returned": killed,
        "shutdown_seconds": round(time.time() - t0, 2),
        "pid": pid,
        "tasklist": probe.stdout.strip()[:200],
        "still_present": str(pid) in probe.stdout,
    }
finally:
    k.close()

# --- 3. after killing the process, does restart work? -----------------------
k = Kernel(transport_encryption="required")
try:
    pid1 = k.pid
    subprocess.run(["taskkill", "/F", "/PID", str(pid1)], capture_output=True, check=False)
    time.sleep(1.0)
    restarted = False
    error = None
    try:
        k.km.restart_kernel(now=True)
        k.kc.wait_for_ready(timeout=30)
        restarted = True
    except Exception as exc:  # noqa: BLE001
        error = repr(exc)[:300]
    pid2 = k.km.provisioner.pid if k.km.provisioner else None
    results = {"pid_before_kill": pid1, "restart_after_kill_ok": restarted, "pid_after": pid2, "error": error}
    if restarted:
        mid = k.execute("print('after-restart', 'x' in dir())")
        iopub, reply, _ = k.drain(mid, timeout=20)
        results["stdout"] = "".join(
            m["content"]["text"] for m in iopub if m["msg_type"] == "stream"
        )
        results["status"] = reply["content"]["status"] if reply else None
    RESULTS["restart_after_process_kill"] = results
finally:
    k.close()

# --- 4. does a plain asyncio sleep interrupt on a fresh kernel? -------------
# Isolates the earlier failure from any residue of prior cells.
k = Kernel(transport_encryption="required")
try:
    mid = k.execute("import asyncio\nawait asyncio.sleep(600)")
    time.sleep(1.5)
    t0 = time.time()
    k.km.interrupt_kernel()
    iopub, reply, _ = k.drain(mid, timeout=12)
    RESULTS["fresh_kernel_await_interrupt"] = {
        "seconds": round(time.time() - t0, 2),
        "settled": reply is not None,
        "status": reply["content"]["status"] if reply else None,
        "ename": reply["content"].get("ename") if reply else None,
    }
    # And: does a *top-level await of a real task* behave the same?
finally:
    k.close()

# --- 5. cancel a top-level await via asyncio task cancellation --------------
k = Kernel(transport_encryption="required")
try:
    mid = k.execute(
        "import asyncio\n"
        "task = asyncio.ensure_future(asyncio.sleep(600))\n"
        "try:\n"
        "    await task\n"
        "except asyncio.CancelledError:\n"
        "    print('cancelled-cleanly')\n"
        "    raise"
    )
    time.sleep(1.5)
    k.km.interrupt_kernel()
    iopub, reply, _ = k.drain(mid, timeout=12)
    RESULTS["await_then_interrupt_with_task"] = {
        "settled": reply is not None,
        "status": reply["content"]["status"] if reply else None,
        "ename": reply["content"].get("ename") if reply else None,
        "stdout": "".join(m["content"]["text"] for m in iopub if m["msg_type"] == "stream"),
    }
finally:
    k.close()

print(json.dumps(RESULTS, indent=2))
