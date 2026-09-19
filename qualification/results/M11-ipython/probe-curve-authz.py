"""Is CurveZMQ an AUTHORISATION boundary, or only an encryption layer?

Requirement 2's justification (from M10.0/FINDINGS.md section 5) is that the
connection file carries the HMAC key that AUTHORISES EXECUTION, so a readable
channel is an execution-capability leak rather than merely a confidentiality one.
That claim has a testable consequence:

  If the curve keys are what authorise, a client that has the PORTS and the HMAC
  key but NOT the curve keys must fail to execute anything.

If instead a keyless client can execute, then "curve keys present" is an
encryption property only, and requirement 2 must be reported as closing
confidentiality but NOT the capability leak.

Every step is bounded by an explicit timeout and a socket-level deadline, because
a probe that hangs is a probe whose result is unknown, not a result of "rejected".
"""
import json
import socket
import time
import traceback

from jupyter_client import BlockingKernelClient, KernelManager

RESULTS = {}
DEADLINE_S = 25.0


def bounded(label, fn, default=None):
    started = time.time()
    try:
        value = fn()
        return {"ok": True, "seconds": round(time.time() - started, 2), "value": value}
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "seconds": round(time.time() - started, 2),
            "error": f"{type(exc).__name__}: {str(exc)[:250]}",
            "traceback_tail": traceback.format_exc()[-400:],
        }


km = KernelManager(transport_encryption="required")
km.start_kernel(stdout=open("sec-k.out", "wb"), stderr=open("sec-k.err", "wb"))
kc = km.client()
kc.start_channels()
kc.wait_for_ready(timeout=60)
cf = json.loads(open(km.connection_file, encoding="utf-8").read())
RESULTS["connection_file_summary"] = {
    "transport": cf.get("transport"),
    "has_key": bool(cf.get("key")),
    "has_curve_publickey": "curve_publickey" in cf,
    "has_curve_secretkey": "curve_secretkey" in cf,
    "shell_port": cf.get("shell_port"),
    "ip": cf.get("ip"),
}

# A control: the properly keyed client executes, proving the cell under test is
# capable of running code at all.
RESULTS["control_keyed_client_executes"] = bounded("control", lambda: (
    lambda mid: (
        kc.get_shell_msg(timeout=15)["content"]["status"]
    )
)(kc.execute("print('KEYED-OK')", allow_stdin=False)))


def keyless_execute():
    """Ports + HMAC key, but NO curve keys: the realistic attacker shape."""
    plain = BlockingKernelClient()
    plain.load_connection_info({
        k: v for k, v in cf.items() if k not in ("curve_publickey", "curve_secretkey")
    })
    plain.start_channels()
    try:
        # Bounded: wait_for_ready on a socket that will never answer must not hang
        # the probe. A timeout here is the EXPECTED outcome if curve authorises.
        try:
            plain.wait_for_ready(timeout=6)
            ready = True
        except Exception as exc:  # noqa: BLE001
            ready = f"{type(exc).__name__}: {str(exc)[:120]}"

        executed = False
        stdout = ""
        reply_status = None
        if ready is True:
            plain.execute("print('KEYLESS-EXECUTED')", allow_stdin=False)
            try:
                reply = plain.get_shell_msg(timeout=6)
                reply_status = reply["content"].get("status")
            except Exception as exc:  # noqa: BLE001
                reply_status = f"no reply: {type(exc).__name__}"
            deadline = time.time() + 4
            while time.time() < deadline:
                try:
                    m = plain.get_iopub_msg(timeout=0.5)
                except Exception:  # noqa: BLE001
                    continue
                if m["msg_type"] == "stream":
                    stdout += m["content"].get("text", "")
            executed = "KEYLESS-EXECUTED" in stdout
        return {
            "wait_for_ready": ready,
            "reply_status": reply_status,
            "stdout": stdout,
            "EXECUTED_WITHOUT_CURVE_KEYS": executed,
        }
    finally:
        try:
            plain.stop_channels()
        except Exception:  # noqa: BLE001
            pass


RESULTS["keyless_client"] = bounded("keyless", keyless_execute)

# A raw DEALER with no session envelope at all, to show the socket answers or not.
def raw_dealer():
    import zmq
    ctx = zmq.Context()
    sock = ctx.socket(zmq.DEALER)
    sock.linger = 0
    sock.rcvtimeo = 4000
    sock.connect(f"tcp://{cf['ip']}:{cf['shell_port']}")
    try:
        sock.send(b"not-a-jupyter-message")
        got = sock.recv()
        return {"reply_bytes": len(got)}
    except Exception as exc:  # noqa: BLE001
        return {"reply": "none", "error": f"{type(exc).__name__}: {str(exc)[:150]}"}
    finally:
        sock.close(0)
        ctx.term()


RESULTS["raw_dealer_without_curve"] = bounded("raw", raw_dealer)

# Is the port even reachable without the curve handshake? A TCP connect proves
# nothing about authorisation, which is exactly the distinction being drawn.
def tcp_reachable():
    sock = socket.socket()
    sock.settimeout(3)
    try:
        sock.connect((cf["ip"], cf["shell_port"]))
        return True
    finally:
        sock.close()


RESULTS["port_tcp_reachable"] = bounded("tcp", tcp_reachable)

kc.stop_channels()
km.shutdown_kernel(now=True)
with open("sec-k.err", "rb") as handle:
    RESULTS["kernel_stderr_tail"] = handle.read().decode("utf-8", "replace")[-500:]

print(json.dumps(RESULTS, indent=2))
