"""Drive kernel-broker.py over stdio and print the raw event stream as JSON.

This is the measurement rig for M5. It exists so the Node-side lifecycle rules
are written against behaviour observed on this machine, not against assumptions
about the Jupyter protocol. Every probe below is a failure the M5 rules respond
to.

ROBUSTNESS MATTERS HERE because the probes deliberately wedge and kill a kernel.
Three defects this file was written to avoid, each of which silently destroyed
evidence in an earlier version:

  * a blocking `readline` makes a hung kernel look like a hung probe, so stdout
    is drained by a thread into a queue and every wait has a real deadline;
  * a section that raises must not destroy the sections that already ran, so
    each is wrapped and its exception is recorded in its own result slot;
  * the execute loop stops polling IOPub the moment a cell settles, so a frame
    written afterwards is never read. The `drain` command exists to read those
    frames, because "no late output observed" would otherwise be an artefact of
    the rig rather than a property of the kernel.

SECTIONS THAT DESTROY THE KERNEL RUN LAST, EACH ON A FRESH BROKER, so an earlier
section's evidence can never be contingent on a later one's cleanup.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BROKER = os.path.join(HERE, "kernel-broker.py")
PY = sys.executable


class Client:
    def __init__(self):
        self.proc = subprocess.Popen(
            [PY, "-u", BROKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        self.events = []
        self.lines = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self.stderr = []
        threading.Thread(target=self._err_reader, daemon=True).start()

    def _reader(self):
        try:
            for line in self.proc.stdout:
                self.lines.put(line)
        except Exception:  # noqa: BLE001
            pass
        self.lines.put(None)

    def _err_reader(self):
        try:
            for line in self.proc.stderr:
                self.stderr.append(line)
        except Exception:  # noqa: BLE001
            pass

    def send(self, obj):
        if self.proc.poll() is not None:
            raise RuntimeError(f"broker already exited rc={self.proc.returncode}")
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def wait_for(self, pred, timeout):
        """Consume events until `pred` holds or the deadline passes. Real deadline."""
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            try:
                line = self.lines.get(timeout=min(0.25, remaining))
            except queue.Empty:
                if self.proc.poll() is not None and self.lines.empty():
                    return None
                continue
            if line is None:
                return None
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:  # noqa: BLE001
                ev = {"ev": "unparsed", "raw": line[:200]}
            self.events.append(ev)
            if pred(ev):
                return ev

    def start(self, timeout=240):
        self.send({"cmd": "start"})
        return self.wait_for(lambda e: e["ev"] in ("ready", "error"), timeout)

    def close(self):
        try:
            self.send({"cmd": "shutdown"})
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=30)
        except Exception:  # noqa: BLE001
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:  # noqa: BLE001
                pass


def of(events, name, cell=None):
    return [e for e in events if e.get("ev") == name and (cell is None or e.get("cellId") == cell)]


def section(results, name, fn):
    """Run one probe section; record its failure instead of aborting the run."""
    try:
        results[name] = fn()
    except Exception as exc:  # noqa: BLE001
        import traceback
        results[name] = {"probe_error": repr(exc)[:400], "traceback": traceback.format_exc()[-900:]}


def run(results, name, body):
    """Boot a broker, run `body(client)`, always tear the broker down."""
    def wrapped():
        c = Client()
        try:
            ready = c.start()
            out = {"ready": ready}
            if ready is None or ready.get("ev") != "ready":
                out["fatal"] = "broker did not become ready"
                return out
            out.update(body(c))
            return out
        finally:
            c.close()
            results.setdefault("_stderr", []).append({
                "section": name,
                "exit": c.proc.returncode,
                "stderr": "".join(c.stderr)[-800:],
            })
    section(results, name, wrapped)


def main():
    results = {}

    def late_output(c):
        c.send({"cmd": "execute", "cellId": "c-late", "maxSeconds": 25, "source": (
            "import threading, time, sys\n"
            "def late():\n"
            "    time.sleep(2.0)\n"
            "    print('LATE-FROM-THREAD', flush=True)\n"
            "threading.Thread(target=late, daemon=True).start()\n"
            "print('cell-done', flush=True)\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-late", 40)
        # The cell is settled. Now read what arrives afterwards, which the
        # execute loop deliberately stopped polling for.
        c.send({"cmd": "drain", "seconds": 4.0, "sinceCell": "c-late",
                "sinceParent": (settled or {}).get("parent")})
        c.wait_for(lambda e: e["ev"] == "drained", 20)
        return {
            "settled": settled,
            "outputs": of(c.events, "output", "c-late"),
            "lateFrames": of(c.events, "late_frame"),
            "foreign": of(c.events, "foreign"),
        }

    def flood(c):
        c.send({"cmd": "execute", "cellId": "c-flood", "capBytes": 65536, "maxSeconds": 180, "source": (
            "chunk = 'x' * 65536\n"
            "for _ in range(2048):\n"
            "    sys.stdout.write(chunk)\n"
            "sys.stdout.write('\\nFLOOD-DONE\\n')\n"
            "sys.stdout.flush()\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-flood", 240)
        c.send({"cmd": "rss"})
        rss = c.wait_for(lambda e: e["ev"] == "rss", 40)
        return {
            "settled": settled,
            "outputCount": len(of(c.events, "output", "c-flood")),
            "outputBytesEmitted": sum(e.get("bytes", 0) for e in of(c.events, "output", "c-flood")),
            "rss": rss,
        }

    def cancel_under_flood(c):
        c.send({"cmd": "execute", "cellId": "c-cancel", "capBytes": 4096, "maxSeconds": 180,
                "interruptAfter": 1.0, "source": (
            "chunk = 'y' * 65536\n"
            "for i in range(200000):\n"
            "    sys.stdout.write(chunk)\n"
            "sys.stdout.flush()\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-cancel", 240)
        sent = of(c.events, "interrupt_sent", "c-cancel")
        done = of(c.events, "interrupt_done", "c-cancel")
        return {
            "settled": settled,
            "interruptSent": sent,
            "interruptDone": done,
            # Control latency under a data flood is RES-01's number: how long
            # from issuing cancel to the cell actually leaving the running state.
            "controlLatencySeconds": (settled or {}).get("seconds"),
            "outputCount": len(of(c.events, "output", "c-cancel")),
        }

    def cpu_interrupt(c):
        c.send({"cmd": "execute", "cellId": "c-cpu", "maxSeconds": 90, "interruptAfter": 1.0,
                "source": "while True:\n    pass\n"})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-cpu", 150)
        return {"settled": settled, "interruptDone": of(c.events, "interrupt_done", "c-cpu")}

    def await_interrupt(c):
        """The case M11 TRANSPORT-FINDINGS recorded: interrupt does not settle.

        The broker's own `maxSeconds` bounds the cell, so this probe always
        terminates. What is measured is (a) that no settle happened within the
        bound although the interrupt was delivered, (b) that the process is still
        alive, and (c) whether the kernel released the cell afterwards -- which
        is the fact that decides whether a bounded-grace `unknown` + restart is
        the only correct Node-side response.
        """
        out = {}
        c.send({"cmd": "execute", "cellId": "c-await", "maxSeconds": 25, "interruptAfter": 2.0,
                "source": "import asyncio\nawait asyncio.sleep(600)\n"})
        out["settled"] = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-await", 90)
        out["interruptSent"] = of(c.events, "interrupt_sent", "c-await")
        out["interruptDone"] = of(c.events, "interrupt_done", "c-await")
        # A SECOND interrupt, as M11 sent at 30 s: does it change anything?
        c.send({"cmd": "interrupt", "cellId": "c-await"})
        out["secondInterruptDone"] = c.wait_for(lambda e: e["ev"] == "interrupt_done", 20)
        c.send({"cmd": "alive"})
        out["aliveAfter"] = c.wait_for(lambda e: e["ev"] == "alive", 40)
        c.send({"cmd": "ping", "id": "busy-check"})
        out["pingAfter"] = c.wait_for(lambda e: e["ev"] == "pong", 20)
        return out

    def reuse_after_wedged(c):
        """After the non-settling interrupt, does a fresh cell run at all?"""
        c.send({"cmd": "execute", "cellId": "c-wedge", "maxSeconds": 15, "interruptAfter": 1.5,
                "source": "import asyncio\nawait asyncio.sleep(600)\n"})
        c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-wedge", 60)
        c.send({"cmd": "execute", "cellId": "c-after", "maxSeconds": 20,
                "source": "print('reuse', 7, flush=True)\n"})
        outcome = c.wait_for(
            lambda e: (e["ev"] in ("settled", "refused")) and e.get("cellId") == "c-after", 60)
        return {
            "secondCellOutcome": outcome,
            "secondCellOutput": of(c.events, "output", "c-after"),
        }

    def kill_and_restart(c):
        out = {}
        c.send({"cmd": "execute", "cellId": "c-hold", "maxSeconds": 25,
                "source": "held = {'answer': 42}\nprint('held-set', flush=True)\n"})
        out["before"] = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-hold", 60)
        c.send({"cmd": "kill"})
        out["killed"] = c.wait_for(lambda e: e["ev"] == "killed", 90)
        c.send({"cmd": "restart"})
        out["restarted"] = c.wait_for(lambda e: e["ev"] == "restarted", 240)
        if out["restarted"] is not None and not out["restarted"].get("error"):
            c.send({"cmd": "execute", "cellId": "c-after-kill", "maxSeconds": 40,
                    "source": "print('held' in dir(), flush=True)\n"})
            out["afterSettle"] = c.wait_for(
                lambda e: e["ev"] == "settled" and e["cellId"] == "c-after-kill", 80)
            out["afterOutput"] = of(c.events, "output", "c-after-kill")
        return out

    def stdin_disabled(c):
        c.send({"cmd": "execute", "cellId": "c-stdin", "maxSeconds": 30,
                "source": "input('give me')\n"})
        return {
            "settled": c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-stdin", 60),
            "outputs": of(c.events, "output", "c-stdin"),
        }

    def mime_payload(c):
        c.send({"cmd": "execute", "cellId": "c-mime", "maxSeconds": 40, "source": (
            "from IPython.display import HTML\n"
            "HTML('<b>' + 'z' * 200000 + '</b>')\n"
        )})
        return {"settled": c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-mime", 80),
                "outputs": of(c.events, "output", "c-mime")}

    def regex_catastrophic(c):
        """A C-extension case: `re` is compiled C, so SIGINT may not land."""
        c.send({"cmd": "execute", "cellId": "c-crec", "maxSeconds": 12, "interruptAfter": 1.0,
                "source": "import re\nre.match(r'(a+)+$', 'a' * 40 + 'b')\n"})
        return {"settled": c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-crec", 60),
                "interruptDone": of(c.events, "interrupt_done", "c-crec")}

    def memory_hold(c):
        """A large object held in the namespace, for the parked-RSS question."""
        c.send({"cmd": "execute", "cellId": "c-mem", "maxSeconds": 120, "source": (
            "import numpy as np\n"
            "big = np.zeros((32, 1024, 1024), dtype=np.float64)  # 256 MiB\n"
            "big[0, 0, 0] = 1.0\n"
            "print('allocated', big.nbytes, flush=True)\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-mem", 180)
        c.send({"cmd": "rss"})
        return {"settled": settled, "rssWithBigObject": c.wait_for(lambda e: e["ev"] == "rss", 40)}

    def restart_after_restart(c):
        """Two restarts: does a second one work, and is the epoch observable?"""
        out = {}
        c.send({"cmd": "execute", "cellId": "c-r1", "maxSeconds": 30,
                "source": "gen = 1\nprint('gen', gen, flush=True)\n"})
        out["before"] = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-r1", 60)
        c.send({"cmd": "restart"})
        out["restart1"] = c.wait_for(lambda e: e["ev"] == "restarted", 240)
        c.send({"cmd": "execute", "cellId": "c-r2", "maxSeconds": 30,
                "source": "print('gen' in dir(), flush=True)\n"})
        out["afterRestart1"] = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-r2", 60)
        out["afterRestart1Output"] = of(c.events, "output", "c-r2")
        c.send({"cmd": "restart"})
        out["restart2"] = c.wait_for(lambda e: e["ev"] == "restarted", 240)
        return out

    # Order matters: kernel-destroying sections last, each on a fresh broker.
    run(results, "late_output", late_output)
    run(results, "flood", flood)
    run(results, "cancel_under_flood", cancel_under_flood)
    run(results, "cpu_interrupt", cpu_interrupt)
    run(results, "await_interrupt", await_interrupt)
    run(results, "reuse_after_wedged", reuse_after_wedged)
    run(results, "stdin_disabled", stdin_disabled)
    run(results, "mime_payload", mime_payload)
    run(results, "regex_catastrophic", regex_catastrophic)
    run(results, "memory_hold", memory_hold)
    run(results, "restart_after_restart", restart_after_restart)
    run(results, "kill_and_restart", kill_and_restart)

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
