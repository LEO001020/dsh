"""Two questions that decide the design.

A. Does CurveZMQ actually AUTHORISE, or is the key just a field in a file?
   Test: connect a client with the connection file's ports but WITHOUT the curve
   keys, and see whether it can execute code. If it can, "keys present" is not a
   security property and requirement 2 must not be reported as met.

B. Can the broker bound a single oversized iopub frame?
   M0/earlier probes showed ipykernel coalesces ~200MB of stdout into ONE zmq
   message. If MAXMSGSIZE drops it, the loss must be reported, not hidden.
"""
import json
import os
import tempfile
import time

import zmq
from jupyter_client import KernelManager

RESULTS = {}

work = tempfile.mkdtemp(prefix="m11-sec-")
kout = open(os.path.join(work, "k.out"), "wb")
kerr = open(os.path.join(work, "k.err"), "wb")

km = KernelManager(transport_encryption="required")
km.start_kernel(stdout=kout, stderr=kerr)
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)
cf = json.loads(open(km.connection_file, encoding="utf-8").read())
RESULTS["connection_file"] = {
    k: (v if k not in ("curve_secretkey", "key") else f"<{len(str(v))} chars>")
    for k, v in cf.items()
}

# --- A. keyless client -------------------------------------------------------
ctx = zmq.Context()
bare = ctx.socket(zmq.DEALER)
bare.linger = 0
bare.rcvtimeo = 5000
bare.connect(f"tcp://127.0.0.1:{cf['shell_port']}")
try:
    bare.send(b"garbage-without-a-session-envelope")
    got = bare.recv()
    RESULTS["keyless_raw_dealer"] = {"reply_bytes": len(got), "reply": got[:120].decode("utf-8", "replace")}
except Exception as exc:  # noqa: BLE001
    RESULTS["keyless_raw_dealer"] = {"error": f"{type(exc).__name__}: {exc}"[:300]}
bare.close(0)

# A proper Jupyter session, correct HMAC key, but NO curve keys: this is the
# realistic attacker -- someone who can read nothing but knows the ports.
from jupyter_client import BlockingKernelClient  # noqa: E402

plain = BlockingKernelClient()
plain.load_connection_info({
    k: v for k, v in cf.items() if k not in ("curve_publickey", "curve_secretkey")
})
plain.start_channels()
try:
    plain.wait_for_ready(timeout=8)
    mid = plain.execute("print('KEYLESS-CLIENT-EXECUTED')")
    reply = plain.get_shell_msg(timeout=8)
    stdout = ""
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            m = plain.get_iopub_msg(timeout=0.4)
        except Exception:
            continue
        if m["msg_type"] == "stream":
            stdout += m["content"]["text"]
    RESULTS["keyless_session_client"] = {
        "reply_status": reply["content"].get("status"),
        "stdout": stdout,
        "executed": "KEYLESS-CLIENT-EXECUTED" in stdout,
    }
except Exception as exc:  # noqa: BLE001
    RESULTS["keyless_session_client"] = {
        "error": f"{type(exc).__name__}: {exc}"[:300],
        "executed": False,
    }
finally:
    try:
        plain.stop_channels()
    except Exception:  # noqa: BLE001
        pass

# --- B. MAXMSGSIZE on the broker's iopub SUB ---------------------------------
# Raw SUB with the curve keys, MAXMSGSIZE set low, then flood.
sub = ctx.socket(zmq.SUB)
sub.linger = 0
sub.curve_secretkey = cf["curve_secretkey"].encode()
sub.curve_publickey = cf["curve_publickey"].encode()
sub.curve_serverkey = cf["curve_publickey"].encode()
sub.maxmsgsize = 1024 * 1024  # 1 MiB
sub.setsockopt(zmq.SUBSCRIBE, b"")
sub.connect(f"tcp://127.0.0.1:{cf['iopub_port']}")
time.sleep(0.5)
mid = kc.execute(
    "chunk = 'x' * 65536\n"
    "for _ in range(1600):\n"
    "    print(chunk, end='')\n"
    "print()\n"
    "print('MARKER')"
)
t0 = time.time()
received = 0
count = 0
dropped_estimate = 0
deadline = time.time() + 25
while time.time() < deadline:
    try:
        frames = sub.recv_multipart()
    except Exception:
        break
    received += sum(len(f) for f in frames)
    count += 1
    # iopub multipart: [topic, <IDS|MSG>, signature, header, parent, metadata, content]
    try:
        content = json.loads(frames[-1])
    except Exception:
        continue
    if content.get("msg_type") == "stream":
        text_len = len(content.get("content", {}).get("text", ""))
        if text_len > 1024 * 1024:
            dropped_estimate += 1
    if content.get("msg_type") == "status" and content.get("content", {}).get("execution_state") == "idle" \
       and content.get("parent_header", {}).get("msg_id") == mid:
        break
sub.close(0)
ctx.term()

# Did the kernel notice / survive? Ask it directly on the (correctly keyed) client.
iopub2 = []
mid2 = kc.execute("print('SURVIVED', 3*3)")
deadline = time.time() + 15
reply2 = None
while time.time() < deadline:
    try:
        m = kc.get_iopub_msg(timeout=0.4)
        iopub2.append(m)
    except Exception:
        pass
    try:
        r = kc.get_shell_msg(timeout=0.05)
        if r["parent_header"].get("msg_id") == mid2:
            reply2 = r
    except Exception:
        pass
    if reply2 is not None and any(
        x["msg_type"] == "status" and x["content"].get("execution_state") == "idle"
        and x["parent_header"].get("msg_id") == mid2 for x in iopub2
    ):
        break

RESULTS["maxmsgsize_sub"] = {
    "maxmsgsize_bytes": 1024 * 1024,
    "messages_received": count,
    "bytes_received": received,
    "seconds": round(time.time() - t0, 2),
    "kernel_survived": reply2 is not None and reply2["content"].get("status") == "ok",
    "survived_stdout": "".join(
        m["content"]["text"] for m in iopub2 if m["msg_type"] == "stream"
    ),
}

kc.stop_channels()
km.shutdown_kernel(now=True)
kout.close()
kerr.close()
with open(os.path.join(work, "k.err"), "rb") as fh:
    RESULTS["kernel_stderr_tail"] = fh.read().decode("utf-8", "replace")[-600:]

print(json.dumps(RESULTS, indent=2))
