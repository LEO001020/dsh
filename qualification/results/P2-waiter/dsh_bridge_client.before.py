"""DSH native-tool bridge client, injected into the kernel by the host.

`dsh.call(name, args)` is an awaitable that runs one DSH native tool through the
host's real ToolRuntime pipeline and returns its canonical value. Nothing about
WHO the call runs as travels on the wire: the host stamps the Agent, Session,
root call id, parent execution token and cancellation from the live `ipython`
call. A program therefore cannot widen its own authority by naming it.

Errors arrive as `BridgeError` with a stable `code` and the policy's own
`message`, so a denial reads as a denial rather than as a transport failure.
"""
import asyncio as _asyncio
import hashlib as _hashlib
import json as _json
import os as _os
import socket as _socket
import struct as _struct
import threading as _threading

_DSH_BRIDGE_VERSION = 1
_HEADER = _struct.Struct(">I")
_MAX_FRAME_BYTES = 4 * 1024 * 1024
_DEFAULT_TIMEOUT = 120.0


class BridgeError(RuntimeError):
    """One refused or failed nested call, with the host's own classification."""

    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message


class Artifact:
    """A canonical result too large to travel inline.

    The bytes were written ONCE by the host from the single execution that
    produced them, so reading this back is not a re-run and cannot differ from
    what the tool returned. `load()` returns exactly those bytes.
    """

    def __init__(self, path, size, sha256):
        self.path = path
        self.bytes = size
        self.sha256 = sha256

    def load(self):
        with open(self.path, "rb") as handle:
            return handle.read()

    def text(self, encoding="utf-8"):
        return self.load().decode(encoding)

    def json(self):
        return _json.loads(self.text())

    def verify(self):
        """Whether the bytes on disk still hash to what the host reported."""
        return _hashlib.sha256(self.load()).hexdigest() == self.sha256

    def __repr__(self):
        return "Artifact(bytes=%d, sha256=%s...)" % (self.bytes, self.sha256[:12])


class _Channel:
    """One connection to the host listener, with a reader thread per socket.

    A single reader thread owns every recv, because two readers on one socket
    race for frames and silently lose them -- the same failure the broker's shell
    router exists to prevent. Replies are matched by request id.
    """

    def __init__(self):
        self._socket = None
        self._reader = None
        self._lock = _threading.Lock()
        self._waiters = {}
        self._counter = 0
        self._port = 0
        self._token = ""
        self._lease = ""
        self._cell = ""
        self._epoch = 0

    def bind(self, port, token, lease_id, cell_id, epoch):
        with self._lock:
            self._port = port
            self._token = token
            self._lease = lease_id
            self._cell = cell_id
            self._epoch = epoch

    def _connect(self):
        """Open the socket and complete the handshake. Caller holds the lock."""
        sock = _socket.create_connection(("127.0.0.1", self._port), timeout=30.0)
        sock.settimeout(None)
        hello = _json.dumps({
            "type": "hello",
            "protocol": _DSH_BRIDGE_VERSION,
            "token": self._token,
        }).encode("utf-8")
        sock.sendall(_HEADER.pack(len(hello)) + hello)
        reply = self._read_frame(sock)
        if reply is None:
            raise BridgeError("BRIDGE_CLOSED", "the host closed the bridge during the handshake")
        if reply.get("type") == "fatal":
            raise BridgeError(reply.get("code", "BRIDGE_REFUSED"), reply.get("message", "the handshake was refused"))
        if not reply.get("ok"):
            raise BridgeError("BRIDGE_REFUSED", "the handshake was not accepted")
        self._socket = sock
        self._reader = _threading.Thread(target=self._read_loop, args=(sock,), daemon=True)
        self._reader.start()

    @staticmethod
    def _read_exactly(sock, count):
        chunks = []
        remaining = count
        while remaining > 0:
            chunk = sock.recv(remaining)
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    @classmethod
    def _read_frame(cls, sock):
        header = cls._read_exactly(sock, _HEADER.size)
        if header is None:
            return None
        (length,) = _HEADER.unpack(header)
        if length > _MAX_FRAME_BYTES:
            raise BridgeError("FRAME_TOO_LARGE", "the host declared a frame larger than the limit")
        body = cls._read_exactly(sock, length)
        if body is None:
            return None
        return _json.loads(body.decode("utf-8"))

    def _read_loop(self, sock):
        while True:
            try:
                message = self._read_frame(sock)
            except Exception:
                message = None
            if message is None:
                with self._lock:
                    waiters = list(self._waiters.values())
                    self._waiters.clear()
                    self._socket = None
                for waiter in waiters:
                    waiter.fail(BridgeError("BRIDGE_CLOSED", "the host closed the bridge before answering"))
                return
            if message.get("type") == "fatal":
                with self._lock:
                    waiters = list(self._waiters.values())
                    self._waiters.clear()
                    self._socket = None
                for waiter in waiters:
                    waiter.fail(BridgeError(message.get("code", "BRIDGE_FATAL"), message.get("message", "the bridge refused this connection")))
                return
            request_id = message.get("requestId")
            with self._lock:
                waiter = self._waiters.pop(request_id, None)
            if waiter is None:
                continue
            if message.get("ok"):
                waiter.succeed(message)
            else:
                error = message.get("error") or {}
                waiter.fail(BridgeError(error.get("code", "BRIDGE_ERROR"), error.get("message", "the call failed")))

    def _ensure_locked(self):
        if self._socket is not None:
            return self._socket
        self._connect()
        return self._socket

    def _send(self, tool, arguments):
        with self._lock:
            sock = self._ensure_locked()
            self._counter += 1
            request_id = "r%d" % self._counter
            payload = _json.dumps({
                "type": "call",
                "requestId": request_id,
                "tool": tool,
                "arguments": arguments,
                "leaseId": self._lease,
                "cellId": self._cell,
                "epoch": self._epoch,
            }).encode("utf-8")
            if len(payload) > _MAX_FRAME_BYTES:
                raise BridgeError(
                    "ARGUMENTS_TOO_LARGE",
                    "the arguments for %r exceed the %d-byte frame limit" % (tool, _MAX_FRAME_BYTES),
                )
            sock.sendall(_HEADER.pack(len(payload)) + payload)
        return request_id

    def call_sync(self, tool, arguments, timeout):
        request_id = self._send(tool, arguments)
        waiter = _SyncWaiter()
        with self._lock:
            self._waiters[request_id] = waiter
        if not waiter.event.wait(timeout):
            with self._lock:
                self._waiters.pop(request_id, None)
            raise BridgeError("TIMEOUT", "%s did not answer within %ss" % (tool, timeout))
        return waiter.result()

    async def call_async(self, tool, arguments, timeout):
        loop = _asyncio.get_running_loop()
        request_id = self._send(tool, arguments)
        waiter = _AsyncWaiter(loop)
        with self._lock:
            self._waiters[request_id] = waiter
        try:
            return await _asyncio.wait_for(waiter.future, timeout)
        except _asyncio.TimeoutError:
            # wait_for raises asyncio.TimeoutError, which is NOT a BridgeError
            # and carries no code. Letting it through would make the async path
            # report a different exception type from the sync one for the same
            # condition, and would break the contract this module's docstring
            # states: every refusal arrives as BridgeError with a stable code,
            # so a caller can branch without parsing prose.
            # MEASURED before this was added: a 4 s tool called with
            # timeout=1.0 raised TimeoutError (MRO TimeoutError,OSError,
            # Exception) with isinstance(exc, BridgeError) False and no .code.
            raise BridgeError("TIMEOUT", "%s did not answer within %ss" % (tool, timeout))
        finally:
            with self._lock:
                self._waiters.pop(request_id, None)


class _SyncWaiter:
    def __init__(self):
        self.event = _threading.Event()
        self._value = None
        self._error = None

    def succeed(self, message):
        self._value = message
        self.event.set()

    def fail(self, error):
        self._error = error
        self.event.set()

    def result(self):
        if self._error is not None:
            raise self._error
        message = self._value or {}
        if "artifact" in message:
            artifact = message["artifact"]
            return Artifact(artifact.get("path"), artifact.get("bytes"), artifact.get("sha256"))
        return message.get("value")


class _AsyncWaiter:
    def __init__(self, loop):
        self.future = loop.create_future()
        self._loop = loop

    def succeed(self, message):
        if self.future.done():
            return
        if "artifact" in message:
            artifact = message["artifact"]
            value = Artifact(artifact.get("path"), artifact.get("bytes"), artifact.get("sha256"))
        else:
            value = message.get("value")
        self._loop.call_soon_threadsafe(_resolve, self.future, value)

    def fail(self, error):
        if self.future.done():
            return
        self._loop.call_soon_threadsafe(_reject, self.future, error)


def _resolve(future, value):
    if not future.done():
        future.set_result(value)


def _reject(future, error):
    if not future.done():
        future.set_exception(error)


class _ToolNamespace:
    """`await dsh.tools.read(file_path=...)` -- attribute access as a call."""

    def __init__(self, channel):
        self._channel = channel

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def invoke(**kwargs):
            return await self._channel.call_async(name, kwargs, _DEFAULT_TIMEOUT)

        invoke.__name__ = name
        return invoke


_channel = _Channel()


def _bind(port, token, lease_id, cell_id, epoch):
    """Point this module at the capability the host minted for the CURRENT cell.

    Called by the host's per-cell preamble. Rebinding is normal: one kernel
    serves many cells, and each gets its own capability.
    """
    _channel.bind(port, token, lease_id, cell_id, epoch)


async def call(name, args=None, timeout=_DEFAULT_TIMEOUT, **kwargs):
    """Run one DSH native tool and return its canonical value.

    `args` is the tool's argument object. Keyword arguments are merged into it,
    so both `call("read", {"file_path": "a.txt"})` and
    `call("read", file_path="a.txt")` work.
    """
    merged = dict(args) if args else {}
    merged.update(kwargs)
    return await _channel.call_async(name, merged, timeout)


def call_sync(name, args=None, timeout=_DEFAULT_TIMEOUT, **kwargs):
    """`call`, for a cell that is not async. Blocks the kernel thread."""
    merged = dict(args) if args else {}
    merged.update(kwargs)
    return _channel.call_sync(name, merged, timeout)


tools = _ToolNamespace(_channel)
