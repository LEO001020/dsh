"""Follow-up probes for the facts the first pass could not establish.

Four questions the first run left open, plus two it raised:

  1. RES-01: control latency under a real output flood. The first run's flood
     cell raised NameError because `sys` was never imported -- each section gets
     a FRESH kernel, so a cell cannot rely on an earlier section's imports.
  2. RES-06: the RSS of a kernel holding a genuinely resident array. `np.zeros`
     is lazily mapped, so the first run measured virtual size, not residency.
  3. THE ONE THAT MATTERS MOST: after an interrupt that does not settle, does
     the kernel EVER become usable again, or is it permanently dead? The first
     run answered `aborted` for the very next cell and produced no output, which
     would make "restart" not merely prudent but mandatory. That needs to be
     established properly rather than inferred from one sample.
  4. SEC-07: can a background thread left over from an old cell touch a new
     cell's memory? This is the honest statement M5 must assert instead of a
     cell-nonce isolation claim, so it is measured rather than asserted.
  5. RES-02: does the broker's own process stay bounded across a flood, i.e. is
     the bound enforced by the broker rather than by the kernel's generosity?
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
        self.stderr = []
        threading.Thread(target=self._reader, daemon=True).start()
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
    try:
        results[name] = fn()
    except Exception as exc:  # noqa: BLE001
        import traceback
        results[name] = {"probe_error": repr(exc)[:400], "traceback": traceback.format_exc()[-900:]}


def run(results, name, body):
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
                "section": name, "exit": c.proc.returncode, "stderr": "".join(c.stderr)[-800:],
            })
    section(results, name, wrapped)


def main():
    results = {}

    # ---- 1. control latency under a real flood (RES-01) --------------------
    def cancel_under_flood(c):
        c.send({"cmd": "execute", "cellId": "c-cancel", "capBytes": 4096, "maxSeconds": 200,
                "interruptAfter": 1.5, "source": (
            "import sys\n"
            "chunk = 'y' * 65536\n"
            "for i in range(400000):\n"
            "    sys.stdout.write(chunk)\n"
            "sys.stdout.flush()\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-cancel", 260)
        return {
            "settled": settled,
            "interruptSent": of(c.events, "interrupt_sent", "c-cancel"),
            "interruptDone": of(c.events, "interrupt_done", "c-cancel"),
            "outputCount": len(of(c.events, "output", "c-cancel")),
            "note": "seconds is cancel-issue-to-settle, the RES-01 control latency",
        }

    # ---- 2. broker bounded across a flood (RES-02) -------------------------
    def flood_bounded(c):
        c.send({"cmd": "rss"})
        before = c.wait_for(lambda e: e["ev"] == "rss", 40)
        c.send({"cmd": "execute", "cellId": "c-flood", "capBytes": 65536, "maxSeconds": 240,
                "source": (
            "import sys\n"
            "chunk = 'x' * 65536\n"
            "for _ in range(4096):\n"
            "    sys.stdout.write(chunk)\n"
            "sys.stdout.write('\\nFLOOD-DONE\\n')\n"
            "sys.stdout.flush()\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-flood", 300)
        c.send({"cmd": "rss"})
        after = c.wait_for(lambda e: e["ev"] == "rss", 40)
        return {
            "beforeRss": before,
            "settled": settled,
            "afterRss": after,
            "outputCount": len(of(c.events, "output", "c-flood")),
            "note": "totalBytes is what the kernel produced; emittedBytes is what the broker kept",
        }

    # ---- 3. is a kernel that did not settle usable afterwards? -------------
    def wedged_then_forever(c):
        """Interrupt an await-suspended cell, then try to use the kernel repeatedly.

        Three follow-up cells, each allowed to run to completion, answer whether
        the kernel is dead for good. This is what decides whether M5 may describe
        the post-grace state as "unknown but maybe reusable" or must say the
        kernel is finished and has to be restarted.
        """
        out = {}
        c.send({"cmd": "execute", "cellId": "c-wedge", "maxSeconds": 20, "interruptAfter": 2.0,
                "source": "import asyncio\nawait asyncio.sleep(600)\n"})
        out["wedgedSettle"] = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-wedge", 60)
        out["interruptDone"] = of(c.events, "interrupt_done", "c-wedge")
        c.send({"cmd": "alive"})
        out["aliveAfterWedge"] = c.wait_for(lambda e: e["ev"] == "alive", 40)
        attempts = []
        for index in range(3):
            cell = f"c-retry-{index}"
            c.send({"cmd": "execute", "cellId": cell, "maxSeconds": 20,
                    "source": f"print('retry-{index}-ran', {index}, flush=True)\n"})
            settled = c.wait_for(
                lambda e, cid=cell: (e["ev"] in ("settled", "refused")) and e.get("cellId") == cid, 60)
            attempts.append({
                "cellId": cell,
                "outcome": settled,
                "output": of(c.events, "output", cell),
            })
            time.sleep(1.0)
        out["attempts"] = attempts
        c.send({"cmd": "err"})
        out["kernelStderr"] = c.wait_for(lambda e: e["ev"] == "kernel_err", 30)
        return out

    # ---- 4. an old background thread touching a NEW cell's memory (SEC-07) --
    def old_thread_touches_new_cell(c):
        """The honest limit, measured.

        Cell 1 leaves a background thread alive that mutates a module-level dict.
        Cell 2 is a DIFFERENT cell with a DIFFERENT id, running in the same
        CPython process. If the thread from cell 1 can change what cell 2 sees,
        then a cell id is an attribution key and NOT an isolation boundary, and
        the M5 assertion must say so.
        """
        out = {}
        c.send({"cmd": "execute", "cellId": "c-owner", "maxSeconds": 30, "source": (
            "import threading, time\n"
            "shared = {'value': 'original'}\n"
            "def mutate():\n"
            "    time.sleep(1.5)\n"
            "    shared['value'] = 'MUTATED-BY-OLD-THREAD'\n"
            "    shared['touched_by'] = 'cell-c-owner'\n"
            "threading.Thread(target=mutate, daemon=True).start()\n"
            "print('owner-cell-done', shared['value'], flush=True)\n"
        )})
        out["ownerCell"] = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-owner", 60)
        time.sleep(2.5)  # let the old thread run while NO cell is active
        c.send({"cmd": "execute", "cellId": "c-victim", "maxSeconds": 30, "source": (
            "print('victim-cell-sees', shared, flush=True)\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-victim", 60)
        out["victimCell"] = settled
        out["victimOutput"] = of(c.events, "output", "c-victim")
        return out

    # ---- 5. resident RSS of a parked kernel holding a real array -----------
    def memory_hold_resident(c):
        c.send({"cmd": "rss"})
        before = c.wait_for(lambda e: e["ev"] == "rss", 40)
        c.send({"cmd": "execute", "cellId": "c-mem", "maxSeconds": 180, "source": (
            "import numpy as np\n"
            "big = np.ones((32, 1024, 1024), dtype=np.float64)  # 256 MiB, actually touched\n"
            "print('allocated', big.nbytes, float(big.sum()) > 0, flush=True)\n"
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-mem", 240)
        c.send({"cmd": "rss"})
        after = c.wait_for(lambda e: e["ev"] == "rss", 40)
        # And after the variable is dropped, does the memory come back? This is
        # the difference between "parked" and "leaked".
        c.send({"cmd": "execute", "cellId": "c-free", "maxSeconds": 60,
                "source": "del big\nimport gc\ngc.collect()\nprint('freed', flush=True)\n"})
        c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-free", 90)
        c.send({"cmd": "rss"})
        freed = c.wait_for(lambda e: e["ev"] == "rss", 40)
        return {"beforeRss": before, "settled": settled, "afterRss": after, "afterFreeRss": freed,
                "outputs": of(c.events, "output", "c-mem")}

    # ---- 6. MIME payload with no broker cap: what does the kernel send? ----
    def mime_bomb(c):
        c.send({"cmd": "execute", "cellId": "c-mimebomb", "maxSeconds": 180, "source": (
            "from IPython.display import HTML\n"
            "HTML('<b>' + 'z' * 20000000 + '</b>')\n"  # 20 MB single MIME payload
        )})
        settled = c.wait_for(lambda e: e["ev"] == "settled" and e["cellId"] == "c-mimebomb", 240)
        c.send({"cmd": "rss"})
        return {"settled": settled, "rss": c.wait_for(lambda e: e["ev"] == "rss", 40)}

    run(results, "cancel_under_flood", cancel_under_flood)
    run(results, "flood_bounded", flood_bounded)
    run(results, "wedged_then_forever", wedged_then_forever)
    run(results, "old_thread_touches_new_cell", old_thread_touches_new_cell)
    run(results, "memory_hold_resident", memory_hold_resident)
    run(results, "mime_bomb", mime_bomb)

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
