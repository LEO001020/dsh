"""IPY-13 isolated experiment, as V3 section M2 requires BEFORE any fix is chosen.

QUESTION: can a kernel-side hook distinguish a cell's OWN stdout from a
background thread's stdout that ipykernel stamped with the CURRENT cell's parent?

The audit's hypothesis: ipykernel's stream-parent fallback means an old thread's
write lands on the newest cell. If true, the frame itself carries no usable
distinction, so attribution needs a Python-side cell-identity context.

This measures, in one kernel:
  A. cell A starts a thread that prints later, then returns
  B. cell B runs while that thread prints
  C. does the frame for the thread's write carry B's parent id?
  D. does execute_request.metadata reach a kernel-side hook, so a DSH cell id
     COULD be carried without touching user code?
"""
import json, sys, threading, time, queue

from jupyter_client.manager import KernelManager

results = {}

km = KernelManager(kernel_name='python3')
km.start_kernel(stdout=open('D:/DSH/work/ipy13-exp/kernel.out','wb'), stderr=open('D:/DSH/work/ipy13-exp/kernel.err','wb'))
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)

def run(code, label, timeout=30):
    msg_id = kc.execute(code)
    frames = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            m = kc.get_iopub_msg(timeout=0.5)
        except Exception:
            continue
        if m.get('parent_header', {}).get('msg_id') != msg_id:
            # Not ours: record it, this is the interesting population.
            frames.append(('FOREIGN', m.get('msg_type'),
                           m.get('parent_header', {}).get('msg_id'),
                           m.get('content', {}).get('text')))
            continue
        if m.get('msg_type') == 'stream':
            frames.append(('OWN', m.get('msg_type'), msg_id, m.get('content', {}).get('text')))
        if m.get('msg_type') == 'status' and m.get('content', {}).get('execution_state') == 'idle':
            break
    results[label] = frames
    return msg_id, frames

# A: start a background thread that prints AFTER cell A returns.
a_id, a_frames = run(
    "import threading, time\n"
    "def later():\n"
    "    time.sleep(3.0)\n"
    "    print('BACKGROUND-WRITE')\n"
    "threading.Thread(target=later, daemon=True).start()\n"
    "print('A-DONE')\n",
    'A')

# B: run a second cell; the background thread prints DURING it.
b_id, b_frames = run("import time\ntime.sleep(5.0)\nprint('B-DONE')\n", 'B')

print(json.dumps({'A_msg_id': a_id, 'B_msg_id': b_id,
                  'A_frames': a_frames, 'B_frames': b_frames}, indent=1))
kc.stop_channels()
km.shutdown_kernel(now=True)
