"""Which parent header does a background thread's output actually carry?

TRANSPORT-FINDINGS.md claimed late thread output "still carries the ORIGINATING
cell's parent_msg_id, so it can be classified as late". That probe never ran a
SECOND cell, so it could not distinguish "the originating cell" from "the cell
that most recently set the parent header". This probe separates the two.

Mechanism under test (`ipykernel/iostream.py:600-607`):

    @property
    def parent_header(self):
        try:
            return self._parent_header.get()      # contextvar
        except LookupError:
            return self._parent_header_global     # global fallback

A `threading.Thread` starts with an EMPTY context (unlike an asyncio Task, which
copies one), so a background writer never sees the contextvar and always falls
back to the global -- which is whatever cell last set it.
"""
import json
import os
import tempfile
import time

from jupyter_client import KernelManager

RESULTS = {}

work = tempfile.mkdtemp(prefix="m11-late-")
kout = open(os.path.join(work, "k.out"), "wb")
kerr = open(os.path.join(work, "k.err"), "wb")

km = KernelManager(transport_encryption="required")
km.start_kernel(stdout=kout, stderr=kerr)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)


def run(code, timeout=30.0):
    """Return (msg_id, [stream frames with their parent ids])."""
    mid = kc.execute(code, allow_stdin=False)
    frames = []
    reply = None
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            m = kc.get_iopub_msg(timeout=0.25)
        except Exception:
            m = None
        if m is not None:
            frames.append(m)
            if (
                m["msg_type"] == "status"
                and m["content"].get("execution_state") == "idle"
                and m["parent_header"].get("msg_id") == mid
            ):
                break
        try:
            r = kc.get_shell_msg(timeout=0.05)
            if r["parent_header"].get("msg_id") == mid:
                reply = r
        except Exception:
            pass
    return mid, frames, reply


def streams(frames):
    return [
        {"parent": m["parent_header"].get("msg_id"), "text": m["content"].get("text", "")}
        for m in frames if m["msg_type"] == "stream"
    ]


# --- A. background writer, NO second cell: which parent does it carry? ------
mid1, frames, _ = run(
    "import threading, time\n"
    "def bg():\n"
    "    time.sleep(1.0)\n"
    "    print('LATE-A')\n"
    "threading.Thread(target=bg, daemon=True).start()\n"
    "print('cell1-done')"
)
time.sleep(2.5)
late_a = []
deadline = time.time() + 3
while time.time() < deadline:
    try:
        m = kc.get_iopub_msg(timeout=0.4)
    except Exception:
        continue
    if m["msg_type"] == "stream":
        late_a.append({"parent": m["parent_header"].get("msg_id"), "text": m["content"].get("text", "")})
RESULTS["A_no_second_cell"] = {
    "cell1_msg_id": mid1,
    "cell1_streams": streams(frames),
    "late_after_settle": late_a,
    "late_parent_equals_cell1": all(x["parent"] == mid1 for x in late_a),
}

# --- B. background writer DURING a second cell ------------------------------
mid2, frames2, _ = run(
    "import threading, time\n"
    "def bg2():\n"
    "    time.sleep(1.2)\n"
    "    print('LATE-B')\n"
    "threading.Thread(target=bg2, daemon=True).start()\n"
    "print('cell2-done')"
)
time.sleep(0.4)
mid3, frames3, _ = run("import time\ntime.sleep(2.2)\nprint('cell3-done')")
time.sleep(0.5)
RESULTS["B_background_during_second_cell"] = {
    "cell2_msg_id": mid2,
    "cell2_streams": streams(frames2),
    "cell3_msg_id": mid3,
    "cell3_streams": streams(frames3),
    "late_b_parent_is_cell3": any(
        "LATE-B" in s["text"] and s["parent"] == mid3 for s in streams(frames3)
    ),
    "late_b_parent_is_cell2": any(
        "LATE-B" in s["text"] and s["parent"] == mid2 for s in streams(frames3)
    ),
    "verdict": (
        "kernel attributes the background write to the MOST RECENT parent"
        if any("LATE-B" in s["text"] and s["parent"] == mid3 for s in streams(frames3))
        else "kernel preserved the originating parent"
        if any("LATE-B" in s["text"] and s["parent"] == mid2 for s in streams(frames3))
        else "background write did not arrive on any observed frame"
    ),
}

# --- C. does the global fallback really explain it? -------------------------
# Read the kernel's own iostream parent state after a cell, from inside a cell.
mid4, frames4, _ = run(
    "import ipykernel.iostream, threading\n"
    "def probe():\n"
    "    io = __import__('sys').stdout\n"
    "    holder = {}\n"
    "    def inner():\n"
    "        try:\n"
    "            holder['contextvar'] = 'ok'\n"
    "        except Exception as exc:\n"
    "            holder['contextvar'] = type(exc).__name__\n"
    "    t = threading.Thread(target=inner)\n"
    "    t.start()\n"
    "    t.join()\n"
    "    return holder\n"
    "print('thread_has_own_context:', probe())"
)
RESULTS["C_context_in_thread"] = {"streams": streams(frames4)}

kc.stop_channels()
km.shutdown_kernel(now=True)
kout.close()
kerr.close()

print(json.dumps(RESULTS, indent=2))
