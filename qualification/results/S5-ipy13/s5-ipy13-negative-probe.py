"""IPY-13 NEGATIVE CONTROL: what if the bootstrap does NOT load?

THE GATE'S OWN GATE. `broker.status()` reports `attributionBootstrapLoaded` by
checking for a marker file. A report is only evidence if it can come out FALSE,
so this probe deliberately prevents the bootstrap from loading and measures what
the status says and what the output does.

The two things it establishes, which the positive arms cannot:

  1. the marker is a REAL fact about the kernel, not a restatement of the argv
     the broker passed -- so `attributionBootstrapLoaded: false` is reachable;
  2. when the bootstrap is absent, THE DEFECT RETURNS, unchanged. The straddling
     write rides the later cell again. That is what makes the fix load-bearing:
     without the bootstrap, nothing else in the system separates the two writes.

The failure is induced the way a real one would happen: an `exec_files` path the
kernel cannot read. IPython logs it and continues, which is precisely why a
silent failure is possible and why the marker exists.

Run: python s5-ipy13-negative-probe.py <out.json>
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
WORK = tempfile.mkdtemp(prefix="s5-ipy13-neg-")

# The broker's own generator runs (so the marker path is the real one), but the
# kernel is pointed at a path that does not exist.
real_path, marker_path = broker.write_attribution_bootstrap(WORK)
missing = os.path.join(WORK, "does-not-exist", broker.ATTRIBUTION_BOOTSTRAP_NAME)
assert not os.path.exists(missing)

results = {
    "work_dir": WORK,
    "bootstrap_generated_but_not_injected": missing,
    "marker_path": marker_path,
    "marker_exists_before_kernel": os.path.exists(marker_path),
}

km = KernelManager(transport_encryption="required")
km.start_kernel(
    stdout=open(os.path.join(WORK, "kernel.out"), "wb"),
    stderr=open(os.path.join(WORK, "kernel.err"), "wb"),
    extra_arguments=["--IPKernelApp.exec_files=" + json.dumps([missing])],
)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)

# The broker's report predicate, applied to this kernel's marker.
results["attributionBootstrapLoaded"] = os.path.exists(marker_path)


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


def own_text(cell):
    return "".join(f.get("text", "") for f in cell["frames"]
                   if f.get("msg_type") == "stream" and f.get("own"))


cell_a = run("import threading, time\n"
             "def straddler():\n"
             "    time.sleep(1.2)\n"
             "    print('NEG-STRADDLER-WRITE')\n"
             "threading.Thread(target=straddler, daemon=True).start()\n"
             "print('neg-cellA-settled')\n")
cell_b = run("import time\n"
             "for i in range(5):\n"
             "    print('neg-tick', i, flush=True)\n"
             "    time.sleep(0.4)\n"
             "print('neg-cellB-settled')\n")

results["cellA_own_text"] = own_text(cell_a)
results["cellB_own_text"] = own_text(cell_b)
results["cellB_foreign_parents"] = [f.get("parent") for f in cell_b["frames"] if not f.get("own")]
results["defect_returned_straddler_rides_cellB"] = "NEG-STRADDLER-WRITE" in own_text(cell_b)

# The kernel-side error, so the failure is not merely inferred from absence.
err_path = os.path.join(WORK, "kernel.err")
try:
    with open(err_path, encoding="utf-8", errors="replace") as handle:
        err = handle.read()
    results["kernel_err_mentions_the_missing_file"] = (
        "does-not-exist" in err or "exec_files" in err
    )
    results["kernel_err_excerpt"] = err[-1200:]
except OSError as exc:
    results["kernel_err_excerpt"] = "unreadable: %s" % exc

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(json.dumps({k: v for k, v in results.items() if k != "kernel_err_excerpt"}, indent=1))
