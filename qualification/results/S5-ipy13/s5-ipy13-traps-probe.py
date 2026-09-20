"""IPY-13 SEMANTIC TRAPS: does the bootstrap change any ordinary Python behaviour?

A fix that makes IPY-13 pass by breaking something else is not a fix. This probe
runs the arms most likely to be disturbed by a stdout wrapper plus a
`threading.Thread.start` hook, and records what each one produced.

  T1  top-level await                    (asyncio Task DOES copy a context)
  T2  a magic that prints                 (%who)
  T3  a traceback with source location
  T4  the displayhook                     (1 + 1 -> execute_result)
  T5  `print` kwargs: sep/end/file=, and sys.stdout.write directly
  T6  a subprocess inheriting stdout      (the child writes to the real fd)
  T7  asyncio.create_task writing         (context IS copied by a Task)
  T8  a thread that outlives its cell AND is joined by a LATER cell
  T9  logging to stderr from a thread
  T10 writing from a thread started BEFORE any cell (no origin at all)
  T11 a thread started inside a thread started by a cell (origin must persist)
  T12 print of a very large string (the buffer path)

Run: python s5-ipy13-traps-probe.py <out.json>
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
WORK = tempfile.mkdtemp(prefix="s5-ipy13-traps-")
boot_path, marker_path = broker.write_attribution_bootstrap(WORK)

km = KernelManager(transport_encryption="required")
km.start_kernel(
    stdout=open(os.path.join(WORK, "kernel.out"), "wb"),
    stderr=open(os.path.join(WORK, "kernel.err"), "wb"),
    extra_arguments=["--IPKernelApp.exec_files=" + json.dumps([boot_path])],
)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)


def run(code, timeout=60):
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
            entry["traceback"] = m.get("content", {}).get("traceback")
        frames.append(entry)
        if m.get("msg_type") == "status" and m.get("content", {}).get("execution_state") == "idle" \
                and parent == msg_id:
            break
    return {"msg_id": msg_id, "frames": frames}


def own(cell, kind=None):
    return "".join(f.get("text", "") for f in cell["frames"]
                   if f.get("own") and (kind is None or f.get("msg_type") == kind))


def foreign(cell):
    return [{"parent": f.get("parent"), "type": f.get("msg_type"), "text": f.get("text")}
            for f in cell["frames"] if not f.get("own")]


results = {"work_dir": WORK, "marker_exists": os.path.exists(marker_path)}

# T1: top-level await
t1 = run("import asyncio\nawait asyncio.sleep(0.01)\nprint('T1-AWAIT-OK')")
results["t1_await"] = {"own": own(t1), "foreign": foreign(t1)}

# T2: magic
t2 = run("%who\nprint('T2-MAGIC-OK')")
results["t2_magic"] = {"own": own(t2), "foreign": foreign(t2)}

# T3: traceback with source location
t3 = run("def boom():\n    raise ValueError('t3-boom')\nboom()")
results["t3_error"] = {"ename": own(t3, "error"), "own_stream": own(t3, "stream"),
                       "traceback": [f.get("traceback") for f in t3["frames"] if f.get("msg_type") == "error"]}

# T4: displayhook
t4 = run("1 + 1")
results["t4_displayhook"] = {"own": own(t4, "execute_result"), "foreign": foreign(t4)}

# T5: print kwargs and direct write
t5 = run("import sys\n"
         "print('a', 'b', sep='-', end='!')\n"
         "print('to-stderr', file=sys.stderr)\n"
         "sys.stdout.write('direct-write\\n')\n"
         "sys.stdout.flush()\n"
         "print()\n")
results["t5_print_kwargs"] = {"own": own(t5), "stderr": own(t5, "stream"), "foreign": foreign(t5)}

# T6: a subprocess writing to the inherited stdout
t6 = run("import subprocess, sys\n"
         "r = subprocess.run([sys.executable, '-c', 'print(\"T6-CHILD-OUTPUT\")'],"
         " capture_output=True, text=True)\n"
         "print('T6-CAPTURED', r.stdout.strip())\n"
         "subprocess.run([sys.executable, '-c', 'import sys; sys.stdout.write(\"T6-INHERITED\\\\n\")'])\n"
         "print('T6-cell-settled')\n")
results["t6_subprocess"] = {"own": own(t6), "foreign": foreign(t6)}

# T7: asyncio task writing (Task copies the context)
t7 = run("import asyncio\n"
         "async def writer():\n"
         "    await asyncio.sleep(0.1)\n"
         "    print('T7-TASK-WRITE')\n"
         "await writer()\n"
         "print('T7-cell-settled')\n")
results["t7_asyncio_task"] = {"own": own(t7), "foreign": foreign(t7)}

# T8: a thread that outlives its cell, joined by a LATER cell
t8a = run("import threading, time\n"
          "holder = {}\n"
          "def slow():\n"
          "    time.sleep(1.5)\n"
          "    print('T8-LATE-FROM-CELL-A')\n"
          "t = threading.Thread(target=slow)\n"
          "holder['t'] = t\n"
          "t.start()\n"
          "print('T8-cellA-settled')\n")
t8b = run("import time\n"
          "holder['t'].join()\n"
          "print('T8-cellB-joined')\n")
results["t8_outliving_thread"] = {"cellA_own": own(t8a), "cellA_foreign": foreign(t8a),
                                  "cellB_own": own(t8b), "cellB_foreign": foreign(t8b)}

# T9: logging to stderr from a background thread
t9 = run("import logging, sys, threading, time\n"
         "logging.basicConfig(stream=sys.stderr, level=logging.INFO)\n"
         "def logger():\n"
         "    time.sleep(0.4)\n"
         "    logging.info('T9-BG-LOG')\n"
         "threading.Thread(target=logger, daemon=True).start()\n"
         "time.sleep(1.0)\n"
         "print('T9-cell-settled')\n")
results["t9_logging"] = {"own": own(t9), "foreign": foreign(t9)}

# T10: a thread started BEFORE any cell (no origin at all)
t10setup = run("import threading, time\n"
               "def pre():\n"
               "    time.sleep(2.5)\n"
               "    print('T10-PRE-CELL-THREAD')\n"
               "threading.Thread(target=pre, daemon=True).start()\n"
               "print('T10-thread-started')\n")
t10b = run("import time\n"
           "for i in range(3):\n"
           "    print('t10-tick', i, flush=True)\n"
           "    time.sleep(0.5)\n"
           "print('T10-cellB-settled')\n")
results["t10_pre_cell_thread"] = {"setup_own": own(t10setup), "cellB_own": own(t10b),
                                  "cellB_foreign": foreign(t10b)}

# T11: a thread started inside a thread started by a cell
t11 = run("import threading, time\n"
          "def inner():\n"
          "    time.sleep(0.4)\n"
          "    print('T11-GRANDCHILD-WRITE')\n"
          "def outer():\n"
          "    t = threading.Thread(target=inner)\n"
          "    t.start()\n"
          "    t.join()\n"
          "t = threading.Thread(target=outer)\n"
          "t.start()\n"
          "t.join()\n"
          "print('T11-cell-settled')\n")
results["t11_grandchild"] = {"own": own(t11), "foreign": foreign(t11)}

# T12: a large string
t12 = run("print('T12-BIG-' + 'x' * 5000)\nprint('T12-cell-settled')\n")
results["t12_large"] = {"own_len": len(own(t12)), "foreign": foreign(t12)}

results["kernel_alive"] = bool(km.is_alive())
kc.stop_channels()
km.shutdown_kernel(now=True)

text = json.dumps(results, indent=1, default=str)
if OUT:
    with open(OUT, "w", encoding="utf-8") as handle:
        handle.write(text)
print(json.dumps({k: v for k, v in results.items() if k not in ("work_dir",)}, indent=1)[:6000])
