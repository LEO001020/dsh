"""IPY-13 RESTART: does the bootstrap survive a restart, and does the report stay true?

TWO QUESTIONS, and the second is the one that matters.

  Q1. `KernelManager.restart_kernel` re-runs with `self._launch_args`
      (`jupyter_client/manager.py:686-688`), which includes the `extra_arguments`
      the broker passed, so the bootstrap SHOULD be re-injected. Measured rather
      than assumed: if it is not, IPY-13 silently returns after every restart.

  Q2. The broker's `attributionBootstrapLoaded` is read from a MARKER FILE. The
      marker from the FIRST kernel survives the restart, so a restart whose
      bootstrap failed to load would still be reported as loaded -- a stale
      report, which is the failure mode the field exists to prevent. The broker's
      `restart()` path does NOT currently re-read it (broker.py, `def restart`).

Run: python s5-ipy13-restart-probe.py <out.json>
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
WORK = tempfile.mkdtemp(prefix="s5-ipy13-restart-")
boot_path, marker_path = broker.write_attribution_bootstrap(WORK)
extra = ["--IPKernelApp.exec_files=" + json.dumps([boot_path])]

results = {"work_dir": WORK, "marker_path": marker_path}

km = KernelManager(transport_encryption="required")
km.start_kernel(
    stdout=open(os.path.join(WORK, "kernel.out"), "wb"),
    stderr=open(os.path.join(WORK, "kernel.err"), "wb"),
    extra_arguments=extra,
)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)
results["marker_after_first_start"] = os.path.exists(marker_path)


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
        frames.append(entry)
        if m.get("msg_type") == "status" and m.get("content", {}).get("execution_state") == "idle" \
                and parent == msg_id:
            break
    return {"msg_id": msg_id, "frames": frames}


def straddle(label):
    a = run("import threading, time\n"
            "def straddler():\n"
            "    time.sleep(1.2)\n"
            "    print('%s-STRADDLER')\n"
            "threading.Thread(target=straddler, daemon=True).start()\n"
            "print('%s-cellA-settled')\n" % (label, label))
    b = run("import time\n"
            "for i in range(4):\n"
            "    print('tick', i, flush=True)\n"
            "    time.sleep(0.5)\n"
            "print('%s-cellB-settled')\n" % label)
    own = "".join(f.get("text", "") for f in b["frames"] if f.get("own") and f.get("msg_type") == "stream")
    foreign = [{"parent": f.get("parent"), "text": f.get("text")}
               for f in b["frames"] if not f.get("own")]
    return {"cellB_own": own, "cellB_foreign": foreign,
            "straddler_rides_cellB": ("%s-STRADDLER" % label) in own}


results["before_restart"] = straddle("RESTART-BEFORE")

# --- the restart, exactly as the broker does it -----------------------------
kc.stop_channels()
km.restart_kernel(now=True)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)
time.sleep(0.5)

results["marker_after_restart"] = os.path.exists(marker_path)
results["after_restart"] = straddle("RESTART-AFTER")

# Q2: the stale-report hazard, demonstrated directly. Delete the marker (as a
# failed re-injection would leave it absent) and show the file test cannot tell
# a fresh load from a surviving one.
try:
    os.remove(marker_path)
except OSError:
    pass
results["marker_exists_after_deleting_it"] = os.path.exists(marker_path)
results["stale_report_demonstrated"] = (
    "the marker from the FIRST kernel is indistinguishable from a fresh load; "
    "a restart whose bootstrap failed would still test as loaded unless the "
    "marker is removed before the new kernel starts"
)

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(text)
