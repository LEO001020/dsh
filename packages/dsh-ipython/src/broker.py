"""Trusted broker: owns jupyter_client and the kernel, speaks bounded framing on fd 7.

WHY A SEPARATE PROCESS. The architecture document (section 11) requires the host
<-> broker control stream to be independent of the busy kernel's shell channel.
Putting jupyter_client in the Node host would also put the kernel's crash surface
in the host's own process. The broker is that boundary: it is the only thing that
touches the connection file, and it holds no model key and runs no sampling loop.

TRANSPORT. `transport_encryption='required'` is passed to KernelManager, never
left to the default. M0 measured that the default start path emits
"Kernel is running over TCP without encryption" and puts no curve keys in the
connection file. That is not only a confidentiality problem: the connection file
carries the HMAC key that AUTHORISES EXECUTION, so a readable channel is an
execution-capability leak. On Windows `transport='ipc'` is impossible (libzmq
answers "Protocol not supported"), so curve keys are the only route, and the
achieved transport is read back from the connection file and reported rather than
assumed.

TWO THREADS, TWO CHANNELS, NO SHARING. One thread owns IOPub and one owns the
shell channel. The shell reader is the cell loop; the IOPub reader is a pump that
routes each frame either to the live cell's accumulator or to the late classifier.
They never touch the same socket, because a second reader on one channel would
race the first for frames and silently lose them.

WHY REQUESTS ARE DISPATCHED OFF THE READ LOOP. `execute` blocks for as long as the
cell runs. If the request loop called it inline, an `interrupt` arriving during
that cell would sit unread in the pipe until the cell finished -- which is exactly
when an interrupt is useless. So `execute` runs on its own worker thread and the
read loop stays free to answer `interrupt`, `status`, and `shutdown`.

WHAT THIS PROCESS WILL NOT DO. It does not decide whether a cell succeeded by
guessing. `ok` requires BOTH the matching `execute_reply` and the matching `idle`
-- the two facts the Jupyter protocol defines as cell completion. A cell whose
outcome cannot be established is reported `unknown`, and the kernel is reset
BEFORE the host is told anything, because a kernel that might still be running
the old cell must not be handed the next one.
"""

import json
import os
import struct
import sys
import threading
import time
import traceback

MAX_FRAME_BYTES = 4 * 1024 * 1024
HEADER = struct.Struct(">I")

# Per-cell output cap. A cell that prints hundreds of MB must not grow the
# broker's or the host's memory without bound, so the cap is enforced HERE,
# closest to the source, and the host is told the output was truncated.
DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024

# How long an interrupt may take to produce a settled cell before the outcome is
# declared unknown and the kernel reset. Measured on this machine: a CPU loop
# settles in ~1.8 s, while an await-suspended cell did NOT settle in 30 s across
# two interrupts. The grace is therefore a real boundary between "interrupted"
# and "unknown", not a retry budget.
DEFAULT_INTERRUPT_GRACE_MS = 5000

CONTROL_FD = 7

# ---------------------------------------------------------------------------
# IPY-13: CELL ATTRIBUTION FOR OUT-OF-THREAD WRITES
#
# THE DEFECT. `_route_iopub` decides attribution from `parent_header.msg_id`
# (line 518/525). That parent is stamped by ipykernel, not here, and ipykernel
# resolves it per write from a ContextVar with a PROCESS-WIDE fallback
# (`ipykernel/iostream.py:596-608`), whose global the setter overwrites on every
# request (`:605-608`, called from `zmqshell.py:723-737`). A `threading.Thread`
# starts with an EMPTY context, so a background writer misses the ContextVar and
# takes the global -- which holds whichever cell ran most recently. The kernel
# therefore stamps a write made by cell A's thread with cell B's msg_id, and the
# check at line 525 is genuinely satisfied. The distinction is destroyed before
# the frame is sent, so no frame-level test here can recover it.
#
# THE FIX, AND WHY IT IS IN THE KERNEL RATHER THAN IN THE ROUTER. The information
# exists only at the moment of the write, so the bootstrap below records it there
# and stamps the frame accordingly. It does NOT guess:
#
#   * a write from a cell's own thread      -> left entirely alone (ipykernel's
#                                              own ContextVar resolves; measured)
#   * a write from a thread STARTED IN a cell -> stamped with THAT cell's header,
#                                              so a thread joined by its own cell
#                                              still reports as that cell's output
#   * a write with no cell origin at all    -> stamped with the sentinel below,
#     (a raw `_thread.start_new_thread`)       which matches no cell and is
#                                              therefore reported as undecidable
#
# The router needs no change: anything whose parent is not the live sink already
# becomes a `late_output` event at line 528-531, which is exactly the required
# classification. The oracle's warning -- "a claim that the originating cell's
# parent id is always preserved is NOT PASS" -- is honoured by the third case:
# preservation is NOT claimed in general, and the case where it fails is
# reported as undecidable rather than attributed.
#
# HOW IT REACHES THE KERNEL. `KernelManager.start_kernel(extra_arguments=...)`
# is public and appends to the kernelspec argv
# (`jupyter_client/provisioning/local_provisioner.py:210,247,250-251`), and
# `--IPKernelApp.exec_files=` is a public IPython config trait
# (`IPython/core/shellapp.py:189`, run by `_run_exec_files` at `:446-456`).
# Measured: the file is executed before the first cell and its namespace is the
# cells' namespace.
# ---------------------------------------------------------------------------

DSH_BACKGROUND_ORIGIN = "dsh:background"
ATTRIBUTION_BOOTSTRAP_NAME = "dsh_attribution_bootstrap.py"
ATTRIBUTION_MARKER_NAME = "dsh_attribution_bootstrap.loaded"


def attribution_bootstrap_source(marker_path):
    """The kernel-side bootstrap that stamps out-of-thread writes.

    Generated rather than shipped as a second file so the package's `files`
    list does not change and the marker path travels with the source. The
    marker is how the broker can TELL whether the bootstrap loaded: without it
    the fix degrades silently back to the defect, which is the failure mode
    this project keeps recording.
    """
    return _ATTRIBUTION_BOOTSTRAP_TEMPLATE.replace(
        "__DSH_MARKER_PATH__", json.dumps(marker_path)
    ).replace("__DSH_BACKGROUND_ORIGIN__", json.dumps(DSH_BACKGROUND_ORIGIN))


_ATTRIBUTION_BOOTSTRAP_TEMPLATE = r'''"""DSH cell-attribution bootstrap, injected by broker.py via exec_files.

WHY IT EXISTS. A write made by a thread that a CELL started carries no cell
identity of its own: ipykernel resolves a stream's parent from a ContextVar and
falls back to a process-wide global when that lookup fails, and a new thread has
an empty context. The global holds the most recently started cell, so such a
write is stamped with a LATER cell's msg_id and is indistinguishable, in every
field the frame carries, from that cell's own output.

WHAT IT DOES. Records the current cell's parent header while a cell runs, carries
it into threads the cell starts, and stamps a write from outside a cell with the
origin it actually has -- or with a sentinel when it has none. It never guesses,
and it does not wrap user code: the cell body runs exactly as IPython would run
it.
"""
import contextvars
import os
import sys
import threading

_DSH_MARKER = __DSH_MARKER_PATH__
_DSH_BACKGROUND = __DSH_BACKGROUND_ORIGIN__

# The parent header of the cell currently executing, or None outside a cell.
_cell_parent = contextvars.ContextVar("dsh_cell_parent", default=None)
# The parent header of the cell that STARTED this thread, or None.
_thread_origin = contextvars.ContextVar("dsh_thread_origin", default=None)

_BACKGROUND_HEADER = {
    "msg_id": _DSH_BACKGROUND,
    "msg_type": "dsh-background",
    "username": "dsh",
    "session": "dsh",
    "version": "5.3",
    "date": None,
}

_installed = []


def _install(stream, name):
    for existing, _ in _installed:
        if existing is stream:
            return
    _installed.append((stream, name))
    original = stream.write

    def write(string):
        # Inside a cell's own execution thread: leave ipykernel entirely alone.
        # Its own ContextVar resolves there (measured), and second-guessing it
        # would change behaviour for output that is already correct.
        if _cell_parent.get(None) is not None:
            return original(string)
        # Outside a cell: use the origin this thread actually has. `None` here
        # means the origin is NOT KNOWN -- a raw `_thread.start_new_thread`, a
        # thread started before any cell -- and that is reported as undecidable
        # rather than attributed to whichever cell happens to be running.
        origin = _thread_origin.get(None)
        previous = stream.parent_header
        stream.set_parent(origin if origin is not None else _BACKGROUND_HEADER)
        try:
            return original(string)
        finally:
            stream.set_parent(previous)

    stream.write = write


def _install_streams():
    for stream, name in ((sys.stdout, "stdout"), (sys.stderr, "stderr")):
        if hasattr(stream, "set_parent") and hasattr(stream, "parent_header"):
            _install(stream, name)


def _pre_run_cell(info):
    try:
        parent = get_ipython().kernel.get_parent()
    except Exception:  # noqa: BLE001
        parent = None
    _cell_parent.set(parent if isinstance(parent, dict) and parent else None)
    # At exec_files time the OutStream normally exists already, but that is an
    # ipykernel implementation detail rather than a guarantee; by the first cell
    # it certainly does. Re-checking here costs nothing and removes the ordering
    # assumption instead of relying on it.
    _install_streams()


def _post_run_cell(result):
    _cell_parent.set(None)


_original_thread_start = threading.Thread.start


def _thread_start(self, *args, **kwargs):
    # The cell this thread descends from: the cell itself when started from cell
    # code, or the origin already carried by a thread that a cell started. The
    # second case matters -- a thread spawned BY a cell-started thread has a
    # knowable origin, and without this it would be reported undecidable when it
    # can be attributed exactly (measured: traps probe T11).
    origin = _cell_parent.get(None)
    if origin is None:
        origin = _thread_origin.get(None)
    if origin is not None:
        inner = self.run

        def run_with_origin(*inner_args, **inner_kwargs):
            _thread_origin.set(origin)
            return inner(*inner_args, **inner_kwargs)

        self.run = run_with_origin
    return _original_thread_start(self, *args, **kwargs)


threading.Thread.start = _thread_start

_ip = get_ipython()
_ip.events.register("pre_run_cell", _pre_run_cell)
_ip.events.register("post_run_cell", _post_run_cell)
_install_streams()

# Written LAST, so the marker means "the hooks above are installed" and not
# merely "the file was read". Deliberately silent: a print here would emit a
# frame with no parent at kernel startup.
try:
    with open(_DSH_MARKER, "w", encoding="utf-8") as _handle:
        _handle.write("installed\n")
except OSError:
    pass
'''


def write_attribution_bootstrap(work_dir):
    """Write the bootstrap into `work_dir` and return (path, marker_path)."""
    path = os.path.join(work_dir, ATTRIBUTION_BOOTSTRAP_NAME)
    marker = os.path.join(work_dir, ATTRIBUTION_MARKER_NAME)
    try:
        os.remove(marker)
    except OSError:
        pass
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(attribution_bootstrap_source(marker))
    return path, marker


def log(detail):
    """Diagnostics go to stderr, never to the control channel."""
    sys.stderr.write("[broker] %s\n" % detail)
    sys.stderr.flush()


class ProtocolError(Exception):
    pass


def encode_frame(value):
    payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise ProtocolError("frame of %d bytes exceeds the limit" % len(payload))
    return HEADER.pack(len(payload)) + payload


class FrameReader:
    """Length-prefixed reader over a blocking byte stream."""

    def __init__(self, stream):
        self._stream = stream
        self._buffer = b""

    def _read_exactly(self, count):
        while len(self._buffer) < count:
            chunk = self._stream.read(count - len(self._buffer))
            if not chunk:
                return None
            self._buffer += chunk
        head, self._buffer = self._buffer[:count], self._buffer[count:]
        return head

    def next_frame(self):
        header = self._read_exactly(HEADER.size)
        if header is None:
            return None
        (length,) = HEADER.unpack(header)
        if length > MAX_FRAME_BYTES:
            raise ProtocolError("declared frame length %d exceeds the limit" % length)
        body = self._read_exactly(length)
        if body is None:
            return None
        return json.loads(body.decode("utf-8"))


class OutputBuffer:
    """Bounded per-cell output accumulation with explicit truncation reporting."""

    def __init__(self, cap):
        self.cap = cap
        self.parts = []
        self.kept = 0
        self.total = 0
        self.truncated = False
        self.dropped_frames = 0
        self.spill_path = None
        self._spill = None

    def add(self, text):
        raw = text.encode("utf-8", "replace")
        self.total += len(raw)
        if self.kept >= self.cap:
            self.truncated = True
            self._spill_bytes(raw)
            return
        room = self.cap - self.kept
        if len(raw) > room:
            self.truncated = True
            self._spill_bytes(raw)
            raw = raw[:room]
        self.parts.append(raw)
        self.kept += len(raw)

    def note_dropped_frame(self):
        """A frame libzmq refused is a loss with no bytes to show; record the fact."""
        self.dropped_frames += 1
        self.truncated = True

    def _spill_bytes(self, raw):
        """Write dropped bytes to a spill file so the loss is recoverable, not just declared."""
        if self.spill_path is None:
            try:
                directory = os.environ.get("DSH_IPYTHON_SPILL_DIR") or os.getcwd()
                name = "ipython-spill-%d-%d.bin" % (os.getpid(), int(time.time() * 1000))
                self.spill_path = os.path.join(directory, name)
                self._spill = open(self.spill_path, "ab")
            except OSError as exc:
                log("spill file unavailable: %s" % exc)
                self.spill_path = None
                return
        if self._spill is not None:
            try:
                self._spill.write(raw)
                self._spill.flush()
            except OSError as exc:
                log("spill write failed: %s" % exc)

    def close(self):
        if self._spill is not None:
            try:
                self._spill.close()
            except OSError:
                pass
            self._spill = None

    def report(self):
        return {
            "text": b"".join(self.parts).decode("utf-8", "replace"),
            "totalBytes": self.total,
            "truncated": self.truncated,
            **({"spillPath": self.spill_path} if self.spill_path else {}),
            "droppedFrames": self.dropped_frames,
        }


class CellSink:
    """The accumulator for exactly one in-flight cell, owned by the IOPub pump."""

    def __init__(self, msg_id, cap):
        self.msg_id = msg_id
        self.stdout = OutputBuffer(cap)
        self.stderr = OutputBuffer(cap)
        self.display = []
        self.error = None
        self.idle_seen = False
        self.late = []
        self.lock = threading.Lock()

    def absorb(self, msg):
        """Consume one IOPub frame whose parent IS this cell."""
        with self.lock:
            msg_type = msg.get("msg_type")
            content = msg.get("content", {})
            if msg_type == "stream":
                text = content.get("text", "")
                if content.get("name") == "stderr":
                    self.stderr.add(text)
                else:
                    self.stdout.add(text)
            elif msg_type == "error":
                self.error = {
                    "ename": content.get("ename", ""),
                    "evalue": content.get("evalue", ""),
                    "traceback": content.get("traceback", []),
                }
                for line in content.get("traceback", []):
                    self.stderr.add(line + "\n")
            elif msg_type in ("display_data", "execute_result"):
                self._absorb_display(content.get("data", {}))
            elif msg_type == "status" and content.get("execution_state") == "idle":
                self.idle_seen = True

    def _absorb_display(self, data):
        """Reduce a display payload to bounded text.

        Binary MIME types are not delivered at all: the model projection is text,
        and a base64 image would be a large blob dressed as a string.
        """
        for mime in ("text/plain", "text/html", "application/json"):
            if mime not in data:
                continue
            raw = data[mime]
            text = raw if isinstance(raw, str) else json.dumps(raw)
            encoded = text.encode("utf-8", "replace")
            limit = 64 * 1024
            self.display.append({
                "mime": mime,
                "text": encoded[:limit].decode("utf-8", "replace"),
                "truncated": len(encoded) > limit,
            })
            return


class ShellRouter:
    """The ONE reader of the shell channel.

    WHY THIS EXISTS AS A SINGLE READER. `get_shell_msg` CONSUMES: whichever caller
    wins the call takes the frame and the others never see it. With `status()`
    served from the request loop and a cell waiting on its reply, both threads
    called it, and the status request ate the cell's `execute_reply`. The cell
    then waited out its whole budget and was reported `unknown` -- a fabricated
    failure caused entirely by the reader design.

    So every shell consumer goes through here. A waiter is registered under the
    request's `msg_id` BEFORE the request is sent, and this thread delivers the
    reply whose `parent_header.msg_id` matches. Frames whose parent matches no
    waiter are counted, never delivered: that is IPY-06 made structural, and it is
    not optional because a stray `kernel_info_reply` left by `wait_for_ready` is
    queued on the shell channel at every kernel start.
    """

    def __init__(self, kc):
        self._kc = kc
        self._waiters = {}
        self._delivered = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.foreign_frames = 0
        self.unmatched = []

    def start(self):
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="shell-router", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._thread = None
        with self._lock:
            for waiter in self._waiters.values():
                waiter.set()
            self._waiters.clear()

    def register(self, msg_id):
        """Declare interest in one request's reply. Call BEFORE sending the request."""
        waiter = threading.Event()
        with self._lock:
            self._waiters[msg_id] = waiter
        return waiter

    def take(self, msg_id):
        """Pop the delivered reply for `msg_id`, or None when it has not arrived."""
        with self._lock:
            return self._delivered.pop(msg_id, None)

    def release(self, msg_id):
        with self._lock:
            self._waiters.pop(msg_id, None)
            self._delivered.pop(msg_id, None)

    def _run(self):
        while not self._stop.is_set():
            kc = self._kc
            if kc is None:
                return
            try:
                reply = kc.get_shell_msg(timeout=0.2)
            except Exception:  # noqa: BLE001  (Empty is the normal case)
                continue
            parent = reply.get("parent_header", {}).get("msg_id")
            with self._lock:
                waiter = self._waiters.get(parent)
                if waiter is None:
                    self.foreign_frames += 1
                    if len(self.unmatched) < 32:
                        self.unmatched.append(
                            {"msg_type": reply.get("msg_type"), "parent": parent}
                        )
                    continue
                self._delivered[parent] = reply
            waiter.set()

    def await_reply(self, msg_id, timeout):
        """Block until the reply for `msg_id` arrives, or the timeout expires."""
        with self._lock:
            waiter = self._waiters.get(msg_id)
        if waiter is None:
            raise ProtocolError("no waiter registered for %s" % msg_id)
        if not waiter.wait(timeout):
            return None
        return self.take(msg_id)


class Broker:
    def __init__(self, write_frame):
        self._write_frame = write_frame
        self._km = None
        self._kc = None
        self._router = None
        self._epoch = 0
        self._transport = "unknown"
        self._curve_keys_present = False
        self._plaintext_warning_seen = False
        # Whether `cwd=` was accepted when the kernel was started. Reported so a
        # manager that ignores it is visible instead of silently rooting the kernel
        # somewhere else.
        self._kernel_cwd_enforced = False
        self._kernel_cwd = None
        # IPY-13. Whether the attribution bootstrap loaded into the live kernel.
        # Reset by every start, because a NEW kernel has its own bootstrap.
        self._attribution_bootstrap_loaded = False
        self._attribution_bootstrap_path = None
        self._kernel_log = None
        self._kernel_err_path = None
        self._sink = None
        self._sink_lock = threading.Lock()
        self._pump_stop = threading.Event()
        self._pump_thread = None
        self._execute_thread = None
        self._interrupt_requested_at = None

    # -- framing ------------------------------------------------------------

    def _send(self, message):
        self._write_frame(message)

    def _event(self, name, **fields):
        self._send({"type": "event", "event": name, "epoch": self._epoch, **fields})

    # -- kernel lifecycle ---------------------------------------------------

    def start(self, request):
        if self._km is not None:
            return self.status()
        from jupyter_client import KernelManager

        work_dir = os.environ.get("DSH_IPYTHON_KERNEL_DIR") or os.getcwd()
        os.makedirs(work_dir, exist_ok=True)
        self._kernel_err_path = os.path.join(work_dir, "kernel.err")
        self._kernel_log = open(os.path.join(work_dir, "kernel.out"), "wb")

        # transport_encryption='required' -- see the module docstring. Passing the
        # default would silently produce an unencrypted, capability-bearing channel.
        km = KernelManager(transport_encryption="required")

        # THE KERNEL'S WORKING DIRECTORY. `KernelManager.start_kernel` does NOT
        # inherit this process's cwd for the kernel: measured, a kernel started
        # with no `cwd` reports the LAUNCHER's directory, and the launcher here is
        # the broker, which runs in the host's scratch directory. So the kernel
        # must be told explicitly.
        #
        # Why it matters: a kernel rooted in a scratch directory makes every
        # relative path in a cell silently resolve somewhere the model will not
        # look. `open("out.csv", "w")` succeeds, reports no error, and writes to a
        # directory the model cannot then find. That is a correctness bug with no
        # symptom, so the directory is passed rather than defaulted.
        #
        # `cwd` is accepted by `start_kernel` and reaches `launch_kernel`
        # (`jupyter_client/launcher.py:92-93`). Measured both ways: without it the
        # kernel reports the launcher's cwd; with it, the requested directory.
        kernel_cwd = os.environ.get("DSH_IPYTHON_KERNEL_CWD") or work_dir
        self._kernel_cwd = kernel_cwd

        # IPY-13: the attribution bootstrap, injected through `extra_arguments`.
        # See the block above `DSH_BACKGROUND_ORIGIN` for why the fix lives in
        # the kernel. Written before the launch so the file exists when the
        # kernel reads its argv.
        bootstrap_path, bootstrap_marker = write_attribution_bootstrap(work_dir)
        self._attribution_bootstrap_path = bootstrap_path
        self._attribution_bootstrap_loaded = False
        extra_arguments = ["--IPKernelApp.exec_files=" + json.dumps([bootstrap_path])]

        start_kwargs = {
            "stdout": self._kernel_log,
            "stderr": open(self._kernel_err_path, "wb"),
            "cwd": kernel_cwd,
            "extra_arguments": extra_arguments,
        }
        try:
            km.start_kernel(**start_kwargs)
        except TypeError:
            # An older/newer manager whose signature rejects `cwd`. Falling back
            # silently would reintroduce the wrong-directory defect, so the kernel
            # is started without it ONLY after recording that the guarantee is not
            # in force; the host reads this back as `kernelCwdEnforced`.
            log(
                "KernelManager.start_kernel rejected cwd=; the kernel's working "
                "directory is NOT the Session's project root"
            )
            self._kernel_cwd_enforced = False
            # `extra_arguments` is NOT dropped along with `cwd`. Without the
            # bootstrap the kernel cannot attribute out-of-thread writes, and
            # IPY-13's defect returns with no other symptom; giving up the cwd
            # guarantee is a recorded degradation, this would be a silent one.
            km.start_kernel(
                stdout=self._kernel_log,
                stderr=open(self._kernel_err_path, "wb"),
                extra_arguments=extra_arguments,
            )
        else:
            self._kernel_cwd_enforced = True
        self._km = km

        # Read the ACHIEVED transport back from the connection file rather than
        # reporting the request: a manager that silently ignored the policy would
        # otherwise be recorded as encrypted.
        with open(km.connection_file, encoding="utf-8") as handle:
            info = json.load(handle)
        self._transport = str(info.get("transport", "unknown"))
        self._curve_keys_present = "curve_publickey" in info and "curve_secretkey" in info
        if self._transport == "tcp" and not self._curve_keys_present:
            raise ProtocolError(
                "kernel started without transport encryption: transport=%s and the connection "
                "file carries no curve keys" % self._transport
            )

        self._kc = km.client()
        self._kc.start_channels()
        self._kc.wait_for_ready(timeout=60)
        self._router = ShellRouter(self._kc)
        self._router.start()
        self._epoch += 1
        self._start_pump()

        # Give the kernel a moment to flush its startup log, then look for the
        # plaintext warning M0 measured. Its ABSENCE is the assertion.
        time.sleep(0.4)
        self._plaintext_warning_seen = self._scan_kernel_log("without encryption")

        # IPY-13: did the attribution bootstrap actually load? Read back from the
        # marker the bootstrap writes as its LAST action, not assumed from the
        # argv we passed: an `exec_files` that silently failed would leave the
        # kernel running with the old, wrong attribution and no other symptom.
        # The status reports it so a caller can tell the two apart.
        self._attribution_bootstrap_loaded = os.path.exists(bootstrap_marker)
        if not self._attribution_bootstrap_loaded:
            log(
                "the IPY-13 attribution bootstrap did NOT load; output written by a "
                "thread started in a cell will be attributed to whichever cell runs next"
            )
        return self.status()

    def _scan_kernel_log(self, needle):
        try:
            with open(self._kernel_err_path, "rb") as handle:
                return needle in handle.read().decode("utf-8", "replace")
        except (OSError, TypeError):
            return False

    def status(self):
        alive = False
        pid = None
        if self._km is not None:
            try:
                alive = bool(self._km.is_alive())
            except Exception:  # noqa: BLE001
                alive = False
            if self._km.provisioner is not None:
                pid = getattr(self._km.provisioner, "pid", None)
        version = None
        if alive:
            try:
                reply = self._shell_request("kernel_info_request", timeout=10)
                version = reply.get("content", {}).get("language_info", {}).get("version")
            except Exception:  # noqa: BLE001
                version = None
        return {
            "alive": alive,
            "epoch": self._epoch,
            "pid": pid,
            "transport": self._transport,
            "curveKeysPresent": self._curve_keys_present,
            "plaintextWarningSeen": self._plaintext_warning_seen,
            "ipythonVersion": version,
            # The directory the kernel was STARTED in, and whether the manager
            # accepted it. A host that reads `kernelCwdEnforced: false` knows the
            # Session's relative paths are not resolving where it asked.
            "kernelCwd": self._kernel_cwd,
            "kernelCwdEnforced": self._kernel_cwd_enforced,
            # IPY-13. False means out-of-thread output is being attributed to
            # whichever cell runs next, i.e. the defect is live. Reported rather
            # than assumed, because an `exec_files` that failed to load leaves no
            # other trace.
            "attributionBootstrapLoaded": self._attribution_bootstrap_loaded,
        }

    # -- the IOPub pump -----------------------------------------------------

    def _start_pump(self):
        """One thread owns IOPub for the kernel's lifetime.

        Frames whose parent is the live cell go to that cell's sink. Everything
        else is late or foreign, and is emitted as an event: the audit requires
        background output be classified separately and never attached to the next
        cell, so it is never merged into a cell result here.
        """
        self._pump_stop = threading.Event()

        def run():
            while not self._pump_stop.is_set():
                kc = self._kc
                if kc is None:
                    return
                try:
                    msg = kc.get_iopub_msg(timeout=0.2)
                except Exception:  # noqa: BLE001  (Empty is the normal case)
                    continue
                try:
                    self._route_iopub(msg)
                except Exception:  # noqa: BLE001
                    log("iopub pump failed on one frame: %s" % traceback.format_exc()[-400:])

        self._pump_thread = threading.Thread(target=run, name="iopub-pump", daemon=True)
        self._pump_thread.start()

    def _route_iopub(self, msg):
        with self._sink_lock:
            sink = self._sink
        parent = msg.get("parent_header", {}).get("msg_id")
        # A frame belongs to this cell ONLY if it carries this cell's parent id AND
        # the cell has not already gone idle. The second condition is decidable and
        # strictly better than the first alone: once idle has been seen the cell is
        # protocol-complete, so anything still arriving is by definition after it,
        # even though the kernel stamped it with this cell's parent id. That case is
        # reachable -- see `late_output_after_idle` below.
        if sink is not None and parent == sink.msg_id and not sink.idle_seen:
            sink.absorb(msg)
            return
        if msg.get("msg_type") == "stream":
            text = msg.get("content", {}).get("text", "")
            if text:
                self._event("late_output", cellId=parent or "", text=text)
        elif msg.get("msg_type") == "error":
            self._event(
                "diagnostic",
                detail="late error frame from %s: %s" % (
                    parent, msg.get("content", {}).get("ename"),
                ),
            )

    def _stop_io(self):
        """Stop both channel readers. Called before any kernel replacement.

        Order matters only in that the router must be gone before a new kernel's
        client exists, so no frame can be delivered to a waiter of the old one.
        """
        self._stop_pump()
        router = self._router
        self._router = None
        if router is not None:
            router.stop()

    def _stop_pump(self):
        self._pump_stop.set()
        thread = self._pump_thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._pump_thread = None

    # -- shell request/reply ------------------------------------------------

    def _shell_request(self, msg_type, content=None, timeout=30):
        """Send one shell request and return the reply whose parent IS this request.

        Delegates to the router, which is the only reader of the channel. Filtering
        by `parent_header.msg_id` is mandatory, not defensive: the supervisor
        reproduced a stray `kernel_info_reply` left by `wait_for_ready` in ALL
        THREE transport modes, so a reader that took "the next shell message" would
        read that frame as the first cell's answer on every kernel start.
        """
        kc = self._kc
        router = self._router
        if kc is None or router is None:
            raise ProtocolError("the kernel is not started")
        msg = kc.session.msg(msg_type, content or {})
        msg_id = msg["header"]["msg_id"]
        # Register BEFORE sending: a reply that arrived between the send and the
        # registration would be classified as foreign and dropped.
        router.register(msg_id)
        try:
            kc.shell_channel.send(msg)
            reply = router.await_reply(msg_id, timeout)
        finally:
            router.release(msg_id)
        if reply is None:
            raise ProtocolError("no reply to %s within %d ms" % (msg_type, timeout * 1000))
        return reply

    # -- cell execution -----------------------------------------------------

    def execute(self, request):
        """Run one cell. Called on a worker thread by the dispatcher."""
        if self._kc is None or self._km is None:
            raise ProtocolError("kernel is not started")
        if not self._km.is_alive():
            # The kernel died since the last call. This is a NEW generation: the
            # host must be told state is gone, never left assuming it survived.
            return self._dead_kernel_result(request)

        code = request.get("code")
        if not isinstance(code, str):
            raise ProtocolError("execute requires a string code")
        cap = request.get("outputCapBytes")
        cap = DEFAULT_OUTPUT_CAP_BYTES if not isinstance(cap, int) or cap <= 0 else cap
        self._interrupt_requested_at = None

        # allow_stdin=False is what makes input()/getpass fail immediately with
        # StdinNotImplementedError instead of parking the cell on a terminal read.
        #
        # The cell's own msg_id is captured so the IOPub pump can tell the live
        # cell's frames from late ones. It is NOT used for shell routing: the
        # router reads the request's `msg_id` off the sent message itself.
        msg = self._kc.session.msg(
            "execute_request",
            {
                "code": code,
                "silent": False,
                "store_history": True,
                "user_expressions": {},
                "allow_stdin": False,
                "stop_on_error": True,
            },
        )
        msg_id = msg["header"]["msg_id"]
        sink = CellSink(msg_id, cap)
        with self._sink_lock:
            self._sink = sink

        timeout_ms = request.get("timeoutMs")
        timeout_ms = 120000 if not isinstance(timeout_ms, int) or timeout_ms <= 0 else timeout_ms
        grace_ms = request.get("interruptGraceMs")
        grace_ms = DEFAULT_INTERRUPT_GRACE_MS if not isinstance(grace_ms, int) or grace_ms <= 0 else grace_ms

        deadline = time.time() + timeout_ms / 1000.0
        reply = None
        try:
            router = self._router
            router.register(msg_id)
            self._kc.shell_channel.send(msg)
            while time.time() < deadline:
                if self._km is None or not self._km.is_alive():
                    return self._dead_kernel_result(request, mid_cell=True, sink=sink)

                if reply is None:
                    reply = router.take(msg_id)

                if reply is not None and sink.idle_seen:
                    break

                requested = self._interrupt_requested_at
                if requested is not None and time.time() - requested > grace_ms / 1000.0:
                    return self._unknown_result(
                        request, sink,
                        "interrupt did not settle the cell within %d ms" % grace_ms,
                    )

                time.sleep(0.01)

            if not (reply is not None and sink.idle_seen):
                reason = (
                    "cell still unsettled after interrupt and the cell timeout"
                    if self._interrupt_requested_at is not None
                    else "cell did not reach execute_reply + idle within %d ms" % timeout_ms
                )
                return self._unknown_result(request, sink, reason)
        finally:
            if self._router is not None:
                self._router.release(msg_id)
            with self._sink_lock:
                self._sink = None

        status = reply.get("content", {}).get("status")
        foreign = self._router.foreign_frames if self._router is not None else 0
        if status == "aborted":
            return self._finish("aborted", sink, foreign,
                                "the kernel aborted the request before running it")
        if self._interrupt_requested_at is not None and status == "error" \
                and reply.get("content", {}).get("ename") == "KeyboardInterrupt":
            return self._finish("interrupted", sink, foreign)
        if status == "error":
            return self._finish("error", sink, foreign)
        return self._finish("ok", sink, foreign)

    def _finish(self, outcome, sink, foreign, unresolved=None):
        sink.stdout.close()
        sink.stderr.close()
        result = {
            "outcome": outcome,
            "stdout": sink.stdout.report(),
            "stderr": sink.stderr.report(),
            "display": sink.display,
            "epoch": self._epoch,
            "foreignFrames": foreign,
        }
        if sink.error is not None:
            result["error"] = sink.error
        if unresolved is not None:
            result["unresolved"] = unresolved
        return result

    def _dead_kernel_result(self, request, mid_cell=False, sink=None):
        """Report a dead kernel as a NEW epoch with the state loss stated.

        The epoch advances HERE, at the moment the loss is established, so that
        every later reply (status included) reports the same new generation. A
        broker that reported the old number would let the host believe the
        namespace it remembers still exists.

        The submitted code is deliberately NOT re-run in the replacement kernel.
        Re-running it would let a cell report success in a namespace that no
        longer holds the variables the code was written against, and that success
        would hide the loss. The caller is told first; its next call runs against
        the fresh kernel.

        When the death happened MID-CELL the outcome is `unknown`, not
        `kernel_died`: the cell may have taken external effects before the process
        died, and those are not established by the kernel being gone.
        """
        previous = self._epoch
        foreign = self._router.foreign_frames if self._router is not None else 0
        if sink is not None:
            sink.stdout.close()
            sink.stderr.close()
        detail = "the kernel process is gone" + (" while a cell was running" if mid_cell else "")
        if self._kernel_err_path:
            detail = detail + "; see " + self._kernel_err_path
        replaced = None
        try:
            self._stop_io()
            if self._km is not None:
                try:
                    self._km.shutdown_kernel(now=True)
                except Exception as exc:  # noqa: BLE001
                    log("shutdown of dead kernel failed: %s" % exc)
            self._km = None
            self._kc = None
            with self._sink_lock:
                self._sink = None
            self.start({})
            replaced = self._epoch
        except Exception as exc:  # noqa: BLE001
            replaced = None
            detail = detail + "; replacement kernel failed to start: %s: %s" % (
                type(exc).__name__, exc,
            )
        self._epoch = previous + 1 if replaced is None else replaced

        if mid_cell:
            result = {
                "outcome": "unknown",
                "stdout": sink.stdout.report() if sink is not None else _EMPTY_OUTPUT,
                "stderr": sink.stderr.report() if sink is not None else _EMPTY_OUTPUT,
                "display": sink.display if sink is not None else [],
                "epoch": self._epoch,
                "foreignFrames": foreign,
                "unresolved": detail,
            }
        else:
            result = {
                "outcome": "kernel_died",
                "stdout": _EMPTY_OUTPUT,
                "stderr": _EMPTY_OUTPUT,
                "display": [],
                "epoch": self._epoch,
                "foreignFrames": 0,
                "unresolved": detail,
            }
        result["generation"] = {
            "previousEpoch": previous,
            "epoch": self._epoch,
            "reason": detail,
            "volatileStateLost": True,
        }
        return result

    def _unknown_result(self, request, sink, reason):
        """Reset first, report second.

        A kernel that might still be running the previous cell must not be handed
        the next one, so the reset happens BEFORE the host is told anything. The
        reported epoch is the post-reset one, because that is the kernel the host
        will actually talk to next.
        """
        previous = self._epoch
        foreign = self._router.foreign_frames if self._router is not None else 0
        result = self._finish("unknown", sink, foreign, reason)
        reset_error = None
        try:
            self._reset_kernel()
        except Exception as exc:  # noqa: BLE001
            reset_error = "%s: %s" % (type(exc).__name__, exc)
        result["epoch"] = self._epoch
        result["generation"] = {
            "previousEpoch": previous,
            "epoch": self._epoch,
            "reason": reason,
            "volatileStateLost": True,
        }
        if reset_error is not None:
            result["unresolved"] = reason + "; reset failed: " + reset_error
        return result

    def _reset_kernel(self):
        self._stop_io()
        with self._sink_lock:
            self._sink = None
        if self._km is not None:
            try:
                self._km.shutdown_kernel(now=True)
            except Exception as exc:  # noqa: BLE001
                log("shutdown during reset failed: %s" % exc)
        self._km = None
        self._kc = None
        self.start({})
        self._event("diagnostic", detail="kernel reset; volatile state lost")

    # -- control ------------------------------------------------------------

    def interrupt(self, request):
        if self._km is None:
            raise ProtocolError("kernel is not started")
        if not self._km.is_alive():
            return {"interrupted": False, "alive": False, "epoch": self._epoch}
        # Stamp BEFORE signalling: the cell loop polls this stamp, and a stamp
        # that arrived after the signal could let the grace window start late and
        # report `interrupted` for a cell that never saw the interrupt.
        self._interrupt_requested_at = time.time()
        self._km.interrupt_kernel()
        return {"interrupted": True, "alive": True, "epoch": self._epoch}

    def restart(self, request):
        if self._km is None:
            raise ProtocolError("kernel is not started")
        self._stop_io()
        with self._sink_lock:
            self._sink = None
        self._km.restart_kernel(now=True)
        self._kc = self._km.client()
        self._kc.start_channels()
        self._kc.wait_for_ready(timeout=60)
        self._router = ShellRouter(self._kc)
        self._router.start()
        self._epoch += 1
        self._start_pump()
        return self.status()

    def shutdown(self, request):
        self._stop_io()
        with self._sink_lock:
            self._sink = None
        if self._kc is not None:
            try:
                self._kc.stop_channels()
            except Exception:  # noqa: BLE001
                pass
        if self._km is not None:
            try:
                self._km.shutdown_kernel(now=True)
            except Exception as exc:  # noqa: BLE001
                log("shutdown failed: %s" % exc)
        self._km = None
        self._kc = None
        self._router = None
        if self._kernel_log is not None:
            try:
                self._kernel_log.close()
            except OSError:
                pass
            self._kernel_log = None
        return {"shutdown": True, "epoch": self._epoch}


_EMPTY_OUTPUT = {"text": "", "totalBytes": 0, "truncated": False, "droppedFrames": 0}


def main():
    raw = os.fdopen(CONTROL_FD, "rb", 0)
    writer_lock = threading.Lock()

    def write_frame(message):
        data = encode_frame(message)
        with writer_lock:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    reader = FrameReader(raw)
    broker = Broker(write_frame)

    def reply(request_id, ok, payload):
        if ok:
            write_frame({"type": "reply", "id": request_id, "ok": True, "result": payload})
        else:
            write_frame({
                "type": "reply",
                "id": request_id,
                "ok": False,
                "error": {"code": "BROKER_FAILURE", "message": payload},
            })

    def run_execute(request, request_id):
        try:
            reply(request_id, True, broker.execute(request))
        except Exception as exc:  # noqa: BLE001
            log("execute failed: %s" % traceback.format_exc()[-1200:])
            reply(request_id, False, "%s: %s" % (type(exc).__name__, exc))

    while True:
        try:
            request = reader.next_frame()
        except ProtocolError as exc:
            log("protocol error: %s" % exc)
            return 2
        except Exception as exc:  # noqa: BLE001
            log("read failed: %s" % exc)
            return 2
        if request is None:
            return 0

        request_id = request.get("id")
        op = request.get("op")
        try:
            if op == "execute":
                # Off the read loop, so an interrupt arriving during the cell is
                # read and acted on instead of waiting for the cell to finish.
                broker._execute_thread = threading.Thread(
                    target=run_execute, args=(request, request_id), name="execute", daemon=True,
                )
                broker._execute_thread.start()
                continue
            if op == "start":
                result = broker.start(request)
            elif op == "interrupt":
                result = broker.interrupt(request)
            elif op == "restart":
                result = broker.restart(request)
            elif op == "shutdown":
                result = broker.shutdown(request)
            elif op == "status" or op == "kernel_info":
                result = broker.status()
            else:
                raise ProtocolError("unknown op %r" % (op,))
            reply(request_id, True, result)
        except Exception as exc:  # noqa: BLE001
            log("op %s failed: %s" % (op, traceback.format_exc()[-1200:]))
            reply(request_id, False, "%s: %s" % (type(exc).__name__, exc))


if __name__ == "__main__":
    sys.exit(main())
