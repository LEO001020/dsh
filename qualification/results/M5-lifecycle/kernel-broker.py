"""A bounded NDJSON broker hosting a REAL ipykernel, for M5 lifecycle measurement.

WHY THIS PROCESS EXISTS. M5's kernel-lifecycle rules are responses to failures
that are properties of the real protocol, not of a stub:

  * an interrupt that never settles (M11 `interrupt_await_suspended`),
  * output that arrives after its cell settled,
  * an output flood large enough to matter,
  * a kernel process that dies under a held variable.

A fake cannot produce any of them. So the Node side is driven against a real
`ipykernel` reached through a real `jupyter_client` connection, and this process
is the smallest thing that can host that kernel and speak a bounded control
protocol over stdio.

TWO CHANNELS, NOT ONE. The kernel's own stdout/stderr are redirected to files.
Cell output arrives as framed IOPub messages. Therefore this process's stdout
carries ONLY NDJSON: user code cannot inject a control frame by printing, which
is the failure the architecture doc calls out for a shared protocol.

BOUNDS ARE ENFORCED HERE, NOT HOPED FOR. Per-cell output is capped at
`capBytes`; past the cap the broker counts bytes and DROPS them rather than
buffering. The `settled` event reports both the emitted (capped) count and the
true total, so a truncation is explicit and never looks like a complete stream.

CONTROL IS A SEPARATE LANE. Commands are read by the MAIN loop, and a cell runs
on a worker thread. That is what makes `interrupt`/`kill` reachable while a
flood is streaming: an earlier version ran the cell in the main loop and drained
control between IOPub polls, which silently swallowed a follow-up `execute` as
an unknown command. Running the cell off the main loop also makes the
single-active-cell rule enforceable here: a second `execute` is REFUSED with a
`busy` event instead of being queued or silently dropped, because the real
service is serial per kernel and a rig that accepts two concurrent cells would
be measuring a different system.

The interrupt itself runs on a further worker thread because
`KernelManager.interrupt_kernel()` can block on a control reply that a wedged
kernel never sends; blocking the pump loop there would reproduce, inside the
measurement rig, exactly the hang under test.
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

from jupyter_client import KernelManager

DEFAULT_CAP_BYTES = 4 * 1024 * 1024


def emit(obj):
    """Write one NDJSON event. Never raises: a broken pipe must not wedge the kernel."""
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


class Broker:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="m5-broker-")
        self.km = None
        self.kc = None
        self.pid = None
        self.out = None
        self.err = None
        self.inbox = queue.Queue()
        self.current = None          # the in-flight cell's state, or None
        self.exec_thread = None
        self.lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()

    # --- stdin reader: the control lane -----------------------------------
    def _reader(self):
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    self.inbox.put(json.loads(line))
                except Exception as exc:  # noqa: BLE001
                    emit({"ev": "bad_command", "raw": line[:200], "error": str(exc)})
        except Exception:  # noqa: BLE001
            pass
        self.inbox.put({"cmd": "__eof"})

    # --- lifecycle --------------------------------------------------------
    def start(self):
        self.out = open(os.path.join(self.dir, "kernel.out"), "wb")
        self.err = open(os.path.join(self.dir, "kernel.err"), "wb")
        # `transport_encryption='required'` per M11 TRANSPORT-FINDINGS: the
        # default path is plaintext and the warning is silent.
        self.km = KernelManager(transport_encryption="required", kernel_name="python3")
        self.km.start_kernel(stdout=self.out, stderr=self.err)
        self.kc = self.km.client()
        self.kc.start_channels()
        self.kc.wait_for_ready(timeout=120)
        self.pid = self.km.provisioner.pid if self.km.provisioner else None
        with open(self.km.connection_file) as handle:
            cf = json.load(handle)
        emit({
            "ev": "ready",
            "pid": self.pid,
            "encrypted": bool(cf.get("curve_publickey")),
            "transport": cf.get("transport"),
            "kernelName": cf.get("kernel_name"),
        })

    def kernel_err_tail(self, limit=600):
        try:
            with open(os.path.join(self.dir, "kernel.err"), "rb") as handle:
                return handle.read().decode("utf-8", "replace")[-limit:]
        except Exception:  # noqa: BLE001
            return ""

    def rss(self):
        try:
            import psutil
        except Exception as exc:  # noqa: BLE001
            return {"ev": "rss", "error": str(exc)}
        result = {"ev": "rss", "self": psutil.Process().memory_info().rss}
        if self.pid:
            try:
                result["kernel"] = psutil.Process(self.pid).memory_info().rss
            except Exception:  # noqa: BLE001
                result["kernel"] = None
        return result

    def alive(self):
        if not self.pid:
            return False
        # BYTES, not text=True. `tasklist` writes its output in the console OEM
        # codepage (cp936 on this machine), so a UTF-8 decode of it raises
        # UnicodeDecodeError inside subprocess's own reader thread. That killed
        # an earlier version of this broker mid-probe: the exception escaped
        # `alive()` and took the whole process down, so the sections after the
        # first process check produced no evidence at all. Decoding with
        # `errors='replace'` cannot fail.
        probe = subprocess.run(
            ["tasklist", "/FI", f"PID eq {self.pid}", "/NH"],
            capture_output=True, check=False,
        )
        return str(self.pid) in probe.stdout.decode("utf-8", "replace")

    # --- the execute loop (runs on a worker thread) ------------------------
    def execute(self, cell_id, source, cap_bytes=None, max_seconds=None, interrupt_after=None):
        cap = DEFAULT_CAP_BYTES if cap_bytes is None else cap_bytes
        limit = 3600.0 if max_seconds is None else float(max_seconds)
        msg_id = self.kc.execute(source, allow_stdin=False)
        started = time.time()
        state = {
            "cellId": cell_id,
            "parent": msg_id,
            "emittedBytes": 0,
            "totalBytes": 0,
            "truncated": False,
            "streamMessages": 0,
            "mimeMessages": 0,
            "foreign": 0,
            "reply": None,
            "idleSeen": False,
            "interruptsRequested": 0,
        }
        with self.lock:
            self.current = state
        try:
            while True:
                elapsed = time.time() - started
                if interrupt_after is not None and elapsed >= interrupt_after and state["interruptsRequested"] == 0:
                    state["interruptsRequested"] += 1
                    self._do_interrupt(cell_id)
                message = self._iopub(0.05)
                if message is not None:
                    self._handle_iopub(message, state, cap)
                reply = self._shell(0.02)
                if reply is not None:
                    parent = reply["parent_header"].get("msg_id")
                    if parent == msg_id:
                        state["reply"] = reply
                    else:
                        state["foreign"] += 1
                        emit({
                            "ev": "foreign",
                            "cellId": cell_id,
                            "chan": "shell",
                            "msgType": reply["msg_type"],
                            "parent": parent,
                            "requested": msg_id,
                        })
                if state["reply"] is not None and state["idleSeen"]:
                    break
                if elapsed > limit:
                    break
        finally:
            with self.lock:
                self.current = None
        content = (state["reply"] or {}).get("content", {})
        emit({
            "ev": "settled",
            "cellId": cell_id,
            "parent": msg_id,
            "replySeen": state["reply"] is not None,
            "idleSeen": state["idleSeen"],
            "status": content.get("status"),
            "ename": content.get("ename"),
            "evalue": content.get("evalue"),
            "executionCount": content.get("execution_count"),
            "seconds": round(time.time() - started, 3),
            "emittedBytes": state["emittedBytes"],
            "totalBytes": state["totalBytes"],
            "truncated": state["truncated"],
            "streamMessages": state["streamMessages"],
            "mimeMessages": state["mimeMessages"],
            "foreignFrames": state["foreign"],
            "timedOut": state["reply"] is None or not state["idleSeen"],
        })

    def _iopub(self, timeout):
        try:
            return self.kc.get_iopub_msg(timeout=timeout)
        except Exception:  # noqa: BLE001
            return None

    def _shell(self, timeout):
        try:
            return self.kc.get_shell_msg(timeout=timeout)
        except Exception:  # noqa: BLE001
            return None

    def _handle_iopub(self, message, state, cap):
        parent = message["parent_header"].get("msg_id")
        msg_type = message["msg_type"]
        # Only the current cell's frames are attributed; anything else is
        # reported as a foreign frame and is NEVER allowed to settle this cell.
        if parent != state["parent"]:
            state["foreign"] += 1
            emit({
                "ev": "foreign",
                "cellId": state["cellId"],
                "chan": "iopub",
                "msgType": msg_type,
                "parent": parent,
                "requested": state["parent"],
            })
            return
        if msg_type == "status":
            if message["content"].get("execution_state") == "idle":
                state["idleSeen"] = True
            return
        if msg_type == "stream":
            text = message["content"].get("text", "")
            raw = len(text.encode("utf-8", "replace"))
            state["totalBytes"] += raw
            state["streamMessages"] += 1
            room = cap - state["emittedBytes"]
            if room <= 0:
                state["truncated"] = True
                return
            piece = text if raw <= room else text.encode("utf-8", "replace")[:room].decode("utf-8", "ignore")
            state["emittedBytes"] += len(piece.encode("utf-8", "replace"))
            if raw > room:
                state["truncated"] = True
            emit({
                "ev": "output",
                "cellId": state["cellId"],
                "parent": parent,
                "msgType": "stream",
                "name": message["content"].get("name"),
                "text": piece,
                "bytes": raw,
                "truncated": raw > room,
            })
            return
        if msg_type in ("execute_result", "display_data", "update_display_data"):
            data = message["content"].get("data", {})
            mime_types = sorted(data.keys())
            state["mimeMessages"] += 1
            sizes = {k: len(v.encode("utf-8", "replace")) if isinstance(v, str) else len(v) for k, v in data.items()}
            state["totalBytes"] += sum(sizes.values())
            emit({
                "ev": "output",
                "cellId": state["cellId"],
                "parent": parent,
                "msgType": msg_type,
                "mimeTypes": mime_types,
                "mimeSizes": sizes,
                "bytes": sum(sizes.values()),
                "truncated": True,  # MIME payloads are counted, never forwarded
            })
            return
        if msg_type == "error":
            emit({
                "ev": "output",
                "cellId": state["cellId"],
                "parent": parent,
                "msgType": "error",
                "ename": message["content"].get("ename"),
                "evalue": message["content"].get("evalue"),
                "tracebackLines": len(message["content"].get("traceback", [])),
                "bytes": 0,
                "truncated": False,
            })
            return
        emit({
            "ev": "output",
            "cellId": state["cellId"],
            "parent": parent,
            "msgType": msg_type,
            "bytes": 0,
            "truncated": False,
        })

    # --- control actions --------------------------------------------------
    def _do_interrupt(self, cell_id):
        """Fire an interrupt on a worker thread; the pump loop keeps running."""
        sent = time.time()
        emit({"ev": "interrupt_sent", "cellId": cell_id, "at": sent})

        def run():
            error = None
            try:
                self.km.interrupt_kernel()
            except Exception as exc:  # noqa: BLE001
                error = repr(exc)[:300]
            emit({
                "ev": "interrupt_done",
                "cellId": cell_id,
                "seconds": round(time.time() - sent, 3),
                "error": error,
            })

        threading.Thread(target=run, daemon=True).start()

    def _kill(self):
        pid = self.pid
        before = self.alive()
        if pid:
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, check=False)
        time.sleep(0.5)
        emit({"ev": "killed", "pid": pid, "aliveBefore": before, "aliveAfter": self.alive()})

    def drain(self, seconds, since_cell=None, since_parent=None):
        """Pump IOPub while NO cell is active and report every frame that arrives.

        WHY THIS EXISTS. The execute loop stops polling the moment reply+idle are
        both seen, which is correct for settling a cell but means a frame written
        by a background thread one second LATER is never read. M11 measured that
        such a frame exists and carries the ORIGINATING cell's parent id; without
        a drain step the rig would report "no late output" and the M5 classifier
        would be tested against an absence the rig itself created.

        Every frame is reported with its parent and whether that parent is the
        cell that already settled. `belongsToSettledCell` is computed HERE, in
        the rig, so the Node side classifies from the parent id rather than from
        this boolean -- the boolean exists to make the measurement auditable.
        """
        deadline = time.time() + seconds
        seen = 0
        while time.time() < deadline:
            message = self._iopub(0.1)
            if message is None:
                continue
            seen += 1
            parent = message["parent_header"].get("msg_id")
            content = message["content"]
            text = content.get("text", "") if message["msg_type"] == "stream" else ""
            emit({
                "ev": "late_frame",
                "msgType": message["msg_type"],
                "parent": parent,
                "sinceCell": since_cell,
                "sinceParent": since_parent,
                "belongsToSettledCell": parent == since_parent,
                "text": text,
                "bytes": len(text.encode("utf-8", "replace")),
                "name": content.get("name"),
                "executionState": content.get("execution_state"),
            })
        emit({"ev": "drained", "seconds": seconds, "frames": seen})

    def _restart(self):
        error = None
        try:
            self.km.restart_kernel(now=True)
            self.kc.wait_for_ready(timeout=120)
        except Exception as exc:  # noqa: BLE001
            error = repr(exc)[:300]
        self.pid = self.km.provisioner.pid if self.km.provisioner else None
        emit({"ev": "restarted", "pid": self.pid, "error": error})

    def _shutdown(self):
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        except Exception:  # noqa: BLE001
            pass
        try:
            if self.km is not None:
                self.km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001
            pass
        if self.pid:
            subprocess.run(["taskkill", "/F", "/PID", str(self.pid)], capture_output=True, check=False)
        for handle in (self.out, self.err):
            try:
                if handle is not None:
                    handle.close()
            except Exception:  # noqa: BLE001
                pass

    def busy(self):
        with self.lock:
            return self.current is not None


def main():
    broker = Broker()
    try:
        while True:
            cmd = broker.inbox.get()
            name = cmd.get("cmd")
            if name == "__eof":
                broker._shutdown()
                os._exit(0)
            elif name == "start":
                broker.start()
            elif name == "execute":
                if broker.busy():
                    # The real service is SERIAL PER KERNEL. Refusing is the honest
                    # rig behaviour; queueing here would hide the property under test.
                    emit({
                        "ev": "refused",
                        "cellId": cmd.get("cellId"),
                        "reason": "busy: one active cell per kernel",
                    })
                    continue
                cell_id = cmd.get("cellId")
                thread = threading.Thread(
                    target=broker.execute,
                    args=(cell_id, cmd.get("source", ""), cmd.get("capBytes"),
                          cmd.get("maxSeconds"), cmd.get("interruptAfter")),
                    daemon=True,
                )
                broker.exec_thread = thread
                thread.start()
            elif name == "ping":
                emit({"ev": "pong", "id": cmd.get("id"), "at": time.time(), "busy": broker.busy()})
            elif name == "drain":
                broker.drain(cmd.get("seconds", 3.0), cmd.get("sinceCell"), cmd.get("sinceParent"))
            elif name == "interrupt":
                broker._do_interrupt(cmd.get("cellId"))
            elif name == "rss":
                emit(broker.rss())
            elif name == "kill":
                broker._kill()
            elif name == "alive":
                emit({"ev": "alive", "pid": broker.pid, "alive": broker.alive()})
            elif name == "err":
                emit({"ev": "kernel_err", "text": broker.kernel_err_tail()})
            elif name == "restart":
                broker._restart()
            elif name == "shutdown":
                broker._shutdown()
                emit({"ev": "shutdown", "pid": broker.pid})
                os._exit(0)
            else:
                emit({"ev": "bad_command", "raw": json.dumps(cmd)[:200]})
    except Exception as exc:  # noqa: BLE001
        import traceback
        emit({"ev": "error", "error": repr(exc)[:400], "traceback": traceback.format_exc()[-1200:]})
        try:
            broker._shutdown()
        finally:
            os._exit(1)


if __name__ == "__main__":
    main()
