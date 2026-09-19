"""Per-case probes with a FRESH kernel each time.

The first pass ran every case against one kernel, so the await-interrupt failure
left the kernel busy and made the later exception probe report `aborted` -- a
measurement artefact, not a fact about the namespace. Isolation is required for
the numbers to mean anything.
"""
import json
import os
import sys
import tempfile
import time

from jupyter_client import KernelManager

RESULTS = {}


class Kernel:
    def __init__(self, **kw):
        self.dir = tempfile.mkdtemp(prefix="m11-case-")
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
                if p == msg_id:
                    iopub.append(m)
                    if m["msg_type"] == "status" and m["content"].get("execution_state") == "idle":
                        break
                else:
                    foreign.append({"chan": "iopub", "type": m["msg_type"], "parent": p})
            try:
                r = self.kc.get_shell_msg(timeout=0.05)
            except Exception:
                r = None
            if r is not None:
                p = r["parent_header"].get("msg_id")
                if p == msg_id:
                    reply = r
                else:
                    foreign.append({"chan": "shell", "type": r["msg_type"], "parent": p})
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


def stdout_of(iopub):
    return "".join(m["content"]["text"] for m in iopub if m["msg_type"] == "stream")


# --- CASE: interrupt an await-suspended cell, then observe recoverability ----
k = Kernel(transport_encryption="required")
try:
    mid = k.execute("import asyncio\nawait asyncio.sleep(600)\nprint('never')")
    time.sleep(2.0)
    t_int = time.time()
    k.km.interrupt_kernel()
    iopub, reply, foreign = k.drain(mid, timeout=20.0)
    entry = {
        "settled": reply is not None and any(
            x["msg_type"] == "status" and x["content"].get("execution_state") == "idle" for x in iopub
        ),
        "seconds_after_interrupt": round(time.time() - t_int, 2),
        "reply_status": reply["content"]["status"] if reply else None,
        "ename": reply["content"].get("ename") if reply else None,
        "stdout": stdout_of(iopub),
        "stderr": "".join(
            m["content"]["text"] for m in iopub
            if m["msg_type"] == "stream" and m["content"]["name"] == "stderr"
        )[:400],
        "foreign": foreign,
    }
    # Can the kernel still take work? A second interrupt is the documented retry.
    t2 = time.time()
    k.km.interrupt_kernel()
    iopub2, reply2, _ = k.drain(mid, timeout=10.0)
    entry["second_interrupt_settled"] = reply2 is not None
    entry["second_interrupt_status"] = reply2["content"]["status"] if reply2 else None
    entry["second_interrupt_ename"] = reply2["content"].get("ename") if reply2 else None
    entry["second_interrupt_seconds"] = round(time.time() - t2, 2)
    entry["second_interrupt_stderr"] = "".join(
        m["content"]["text"] for m in iopub2
        if m["msg_type"] == "stream" and m["content"]["name"] == "stderr"
    )[:400]
    # Is the kernel still alive as a process after all that?
    entry["process_alive_after"] = k.km.is_alive()
    RESULTS["interrupt_await_suspended"] = entry
finally:
    k.close()

# --- CASE: is a *fresh* kernel's await cell interruptible at all? -------------
k = Kernel(transport_encryption="required")
try:
    mid = k.execute("import asyncio\nawait asyncio.sleep(600)")
    time.sleep(1.5)
    k.km.interrupt_kernel()
    time.sleep(3.0)
    # Send a plain CPU cell; if the await cell were still running this would queue.
    mid2 = k.execute("print('AFTER-AWAIT-INTERRUPT')")
    iopub2, reply2, _ = k.drain(mid2, timeout=15.0)
    RESULTS["after_await_interrupt_plain_cell"] = {
        "stdout": stdout_of(iopub2),
        "status": reply2["content"]["status"] if reply2 else None,
        "ename": reply2["content"].get("ename") if reply2 else None,
    }
finally:
    k.close()

# --- CASE: exception does not roll back the namespace, on a CLEAN kernel -----
k = Kernel(transport_encryption="required")
try:
    mid = k.execute("kept = 11\nraise ValueError('boom')")
    iopub, reply, _ = k.drain(mid, timeout=30.0)
    first = {
        "status": reply["content"]["status"] if reply else None,
        "ename": reply["content"].get("ename") if reply else None,
        "evalue": reply["content"].get("evalue") if reply else None,
        "traceback_lines": len(reply["content"].get("traceback", [])) if reply else None,
    }
    mid2 = k.execute("print('kept:', kept)")
    iopub2, reply2, _ = k.drain(mid2, timeout=30.0)
    RESULTS["exception_no_rollback"] = {
        "first": first,
        "second_stdout": stdout_of(iopub2),
        "second_status": reply2["content"]["status"] if reply2 else None,
    }
finally:
    k.close()

# --- CASE: bounded output -- does the kernel survive a 200MB stdout flood? ---
k = Kernel(transport_encryption="required")
try:
    t0 = time.time()
    mid = k.execute(
        "chunk = 'x' * 65536\n"
        "for _ in range(3200):\n"
        "    print(chunk, end='')\n"
        "print()\n"
        "print('FLOOD-DONE')"
    )
    iopub, reply, _ = k.drain(mid, timeout=90.0)
    total = sum(len(m["content"].get("text", "")) for m in iopub if m["msg_type"] == "stream")
    RESULTS["stdout_flood_200mb"] = {
        "seconds": round(time.time() - t0, 2),
        "iopub_stream_bytes_received": total,
        "stream_message_count": sum(1 for m in iopub if m["msg_type"] == "stream"),
        "reply_status": reply["content"]["status"] if reply else None,
        "saw_flood_done": "FLOOD-DONE" in stdout_of(iopub),
        "kernel_alive": k.km.is_alive(),
    }
finally:
    k.close()

# --- CASE: kill -9 the kernel process, then observe --------------------------
k = Kernel(transport_encryption="required")
try:
    pid = k.pid
    alive_before = k.km.is_alive()
    import subprocess as sp
    sp.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, check=False)
    time.sleep(1.5)
    alive_after = k.km.is_alive()
    mid = k.execute("print('should never run')")
    iopub, reply, _ = k.drain(mid, timeout=6.0)
    RESULTS["kernel_killed"] = {
        "pid": pid,
        "alive_before": alive_before,
        "alive_after_taskkill": alive_after,
        "reply_after_kill": reply is not None,
        "iopub_after_kill": len(iopub),
    }
finally:
    k.close()

# --- CASE: what does an execute on a dead client channel do? ----------------
k = Kernel(transport_encryption="required")
try:
    k.kc.stop_channels()
    RESULTS["stopped_channels_execute"] = {"stopped": True}
finally:
    k.close()

print(json.dumps(RESULTS, indent=2))
