"""``dsh.data`` -- the high-throughput programmatic data plane, for a DSH IPython cell.

WHAT THIS MODULE IS, AND THE ONE THING IT MUST NOT DO.

It is a THIN CLIENT over the host's `dsh.data` plane. Every call goes to the host,
which owns authority, storage, pagination and the concurrency bound. This module
holds no bytes, no cache, no cursor secret and no credential.

It must NOT turn bulk data into Python objects that then travel back to the model.
The invariant the whole plane exists for is:

    acquired bytes != persisted bytes != Python-consumed bytes != LLM-visible bytes

A cell may consume 32 MiB here and emit 400 bytes, and that is the plane working,
not a loss.

WHY THE SURFACE IS THIS SMALL.

V3 §K5 requires a small surface, and this module is deliberately the whole of it.
There is no ``dsh.data.fs.list``, no ``dsh.data.history.by_id``, no second way to
do anything. A wide surface of thin wrappers is how a data plane becomes a second
generic tool registry, which this project forbids by name.

HOW IT IS LOADED (the contract with the bridge).

The host's per-cell preamble injects the ``dsh`` module and calls ``_bind`` on it.
This module is installed by ONE call:

    install(dsh_module)          # adds dsh_module.data
    install(dsh_module, channel) # or supply the call channel explicitly

It finds the call channel from the ``dsh`` module itself
(``dsh_module._channel.call_async``), so it needs no import of the bridge client's
internals and no second socket. If the bridge client ever renames that attribute,
``install`` raises immediately and loudly rather than silently registering a
namespace whose every method fails.

NOTHING HERE IS AUTHORITY. ``dsh.data`` requests are bound to the live cell by the
host: which Agent, Session, workspace and cancellation they run under is decided
from the enclosing execution. A program that rewrites this file or hand-builds a
request gains nothing, because the host does not read authority from the payload.
"""

import base64 as _base64
import json as _json

__all__ = ["install", "DataError", "Observation", "PageWalk", "DATA_API_VERSION"]

#: The client's own API version, checked by the host BEFORE it exposes a live
#: capability (V5 §5.3). A client from a different version disagrees with the
#: host about which fields are authority-bearing, so the disagreement must be a
#: BIND-TIME refusal rather than a namespace that answers wrongly later. Bump this
#: whenever the request/response contract changes shape, and bump the host's
#: expected value in the same change: the two are compared for equality.
DATA_API_VERSION = 1

#: The reserved tool-name prefix the host's router dispatches on. Must match
#: ``DATA_TOOL_PREFIX`` in ``data-bridge.ts``; ``test-data-bridge`` asserts they
#: agree, because a drifted prefix would make every call an unknown-method refusal.
_PREFIX = "data:"


class DataError(RuntimeError):
    """One refused or failed data-plane call, with the host's own classification.

    ``code`` is stable and machine-routable; ``message`` is the host's prose. They
    are separate so a caller branches on the code without parsing text -- the same
    discipline the bridge client applies to tool calls.
    """

    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message


class Observation:
    """A reference to bytes the host captured, plus the identity it captured them under.

    NOT a buffer. The bytes live in the host's artifact store; this object is the
    address and the provenance. ``pages()`` is how they are read, and it reads them
    in bounded windows so a 32 MiB artifact never becomes a 32 MiB Python string.
    """

    def __init__(self, client, payload):
        self._client = client
        # The descriptor is the host's own document. Kept verbatim: re-deriving it
        # here would create a second, possibly-divergent representation of a
        # host-authored fact.
        self.descriptor = payload.get("descriptor")
        self.observation_id = payload.get("observation_id")
        self.identity = payload.get("identity") or {}
        self.reference = payload.get("reference") or {}
        #: Bytes the SOURCE read cost during capture.
        self.acquired_bytes = payload.get("acquired_bytes", 0)
        #: Bytes the store actually holds. Equal for a complete capture; smaller
        #: when the source shrank mid-capture, which is a recorded gap.
        self.persisted_bytes = payload.get("persisted_bytes", 0)
        #: Recorded losses, each with its acquisition stage. Empty means none.
        self.gaps = payload.get("gaps") or []

    @property
    def artifact(self):
        """The content-addressed artifact reference."""
        return (self.descriptor or {}).get("captured", {}).get("artifact")

    @property
    def sha256(self):
        """The digest of the exact captured bytes."""
        return (self.descriptor or {}).get("captured", {}).get("sha256")

    @property
    def bytes(self):
        """The captured byte count."""
        return (self.descriptor or {}).get("captured", {}).get("bytes")

    @property
    def complete(self):
        """Whether the capture is complete FOR THE REQUESTED SCOPE.

        Never a claim about the world: a provider may have sent a truncated body
        without saying so, and no client can detect that from the bytes.
        """
        return (self.descriptor or {}).get("acquisition", {}).get("completeness") == "complete-within-request"

    async def pages(self, max_bytes=65536, max_pages=None):
        """Walk the captured artifact in bounded windows.

        :param max_bytes: window size. The host refuses a non-positive value.
        :param max_pages: optional page budget; omit to walk to exhaustion.
        :returns: a :class:`PageWalk` with the accounting and the per-page reader.
        """
        return await self._client._walk(self.descriptor, max_bytes, max_pages)

    async def read_range(self, offset, length):
        """Read one byte range, decoded to ``bytes``.

        The caller named the size, so an inline return is correct here. The bound
        is the caller's own, not an accident of a buffer somewhere.
        """
        payload = await self._client._call("fs.read_range", {
            "descriptor": self.descriptor,
            "offset": offset,
            "length": length,
        })
        return _base64.b64decode(payload.get("bytes", ""))

    async def save_attachment(self, name=None):
        """Copy the artifact's exact bytes into DSH's public attachment store.

        Used when a capture must be referenced by a Session message. The host
        streams from the immutable artifact, and cross-checks the attachment store's
        content address against the observation's own digest -- two independent
        stores agreeing is a real integrity check, not a restatement.
        """
        arguments = {"descriptor": self.descriptor}
        if name is not None:
            arguments["name"] = name
        return await self._client._call("artifacts.save", arguments)


class PageWalk:
    """The result of walking an artifact: the accounting, and the pages themselves.

    ``pages`` is the host's own count and ``bytes`` its own total, so the numbers
    are the store's rather than this client's arithmetic. ``io`` carries the
    physical read cost, which is what makes "paging is O(pages), not O(pages x
    file)" a measurement rather than a claim.
    """

    def __init__(self, client, payload, max_bytes):
        self._client = client
        self.observation_id = payload.get("observation_id")
        self.artifact = payload.get("artifact")
        self.sha256 = payload.get("sha256")
        self.artifact_bytes = payload.get("artifact_bytes", 0)
        self.pages = payload.get("pages", 0)
        self.bytes = payload.get("bytes", 0)
        self.exhausted = payload.get("exhausted", False)
        self.io = payload.get("io") or {}
        self._max_bytes = max_bytes

    async def __aiter__(self):
        """Yield bounded pages until the artifact is exhausted.

        Each page is one host round trip, so a caller that wants only the first few
        pages can ``break`` and stop paying. The host re-reads nothing per page: it
        reads one byte window of an immutable object.
        """
        cursor = None
        seen = 0
        while True:
            arguments = {"descriptor": self._client._descriptor_of(self), "max_bytes": self._max_bytes}
            if cursor is not None:
                arguments["cursor"] = cursor
            page = await self._client._call("fs.page", arguments)
            chunk = _base64.b64decode(page.get("bytes", ""))
            seen += len(chunk)
            yield chunk
            if page.get("exhausted"):
                return
            cursor = page.get("nextCursor")
            if cursor is None:
                # The host reported not-exhausted without a continuation cursor.
                # Guessing here would loop forever, so this is a refusal.
                raise DataError(
                    "PAGINATION_STALLED",
                    "the host reported an unfinished walk with no continuation cursor",
                )


class _History:
    """Programmatic history access, scoped to the caller's own authority."""

    def __init__(self, client):
        self._client = client

    async def search(self, query, session_id=None, cursor=None, max_hits=None, surfaces=None):
        """Search the caller's authorized history against ONE pinned observation.

        The first call pins an exact immutable cut; later pages filter the SAME cut
        in memory. That is what makes a 100-page traversal one observation instead
        of one hundred log loads.

        Authority is host-owned: the caller's Session and workspace come from the
        live cell, so passing ``session_id`` selects a target WITHIN what the
        enclosing execution may already read. It does not widen anything.
        """
        arguments = {"query": query}
        if session_id is not None:
            arguments["session_id"] = str(session_id)
        if cursor is not None:
            arguments["cursor"] = cursor
        if max_hits is not None:
            arguments["max_hits"] = max_hits
        if surfaces is not None:
            arguments["surfaces"] = list(surfaces)
        return await self._client._call("history.search", arguments)

    async def close(self, cursor):
        """Release a pinned scan early. Idempotent."""
        return await self._client._call("history.close", {"cursor": cursor})


class _Web:
    """Web acquisition through the host's own provider seam."""

    def __init__(self, client):
        self._client = client

    async def fetch(self, url, max_body_chars=None, etag=None, last_modified=None):
        """Fetch one URL and record the acquisition.

        The BODY is not returned: a fetched page is bulk data, so the record comes
        back and the bytes stay in the host. A provider that capped the body is
        recorded as ``partial`` with a ``provider-acquisition`` gap, and a REFETCH
        creates a NEW observation -- an older partial record is never rewritten into
        a complete one.
        """
        arguments = {"url": url}
        if max_body_chars is not None:
            arguments["max_body_chars"] = max_body_chars
        if etag is not None:
            arguments["etag"] = etag
        if last_modified is not None:
            arguments["last_modified"] = last_modified
        return await self._client._call("web.fetch", arguments)

    async def search(self, query, max_results=None):
        """Search, and record the result as a RANKING rather than an enumeration.

        A provider that could not answer raises -- it is NEVER reported as "no
        results", because collapsing a failure into an empty list fabricates
        evidence. Zero hits from a WORKING provider is a legitimate empty list.
        """
        arguments = {"query": query}
        if max_results is not None:
            arguments["max_results"] = max_results
        return await self._client._call("web.search", arguments)


class _Artifacts:
    """Durable verbatim bytes in DSH's public attachment store."""

    def __init__(self, client):
        self._client = client

    async def open(self, attachment_id, name, bytes):
        """Read a stored file back, with its digest verified by the host.

        A missing or corrupt object FAILS LOUD: a short object is never returned as
        if it were the stored one.
        """
        return await self._client._call("artifacts.open", {
            "attachment_id": attachment_id,
            "name": name,
            "bytes": bytes,
        })


class _Projection:
    """The model-projection manifest: what the model was SHOWN, as its own fact.

    Deliberately separate from acquisition. Showing the model 400 bytes of a 32 MiB
    artifact is a CHOICE, and recording it as an acquisition loss would make an
    honest system look broken. The manifest therefore refuses to exist when bytes
    were omitted and nothing says how to recover them.
    """

    def __init__(self, client):
        self._client = client

    async def manifest(self, observations, emitted, selector_name, selector_version,
                       mode="bounded", selected_bytes=0, selected_items=None,
                       omitted_bytes=None, omitted_items=None, selector_digest=None):
        """Record a projection.

        :param observations: the :class:`Observation` objects the projection drew on.
        :param emitted: the EXACT string that entered the next model request.
        :param mode: ``exhaustive`` | ``bounded`` | ``sampled`` | ``head``. Only
            ``exhaustive`` makes the omission count a measurement; every other mode
            records it as a floor, which is why the mode is required.
        """
        arguments = {
            "descriptors": [o.descriptor for o in observations],
            "emitted": emitted,
            "selector_name": selector_name,
            "selector_version": selector_version,
            "mode": mode,
            "selected_bytes": selected_bytes,
        }
        if selector_digest is not None:
            arguments["selector_digest"] = selector_digest
        if selected_items is not None:
            arguments["selected_items"] = selected_items
        if omitted_bytes is not None:
            arguments["omitted_bytes"] = omitted_bytes
        if omitted_items is not None:
            arguments["omitted_items"] = omitted_items
        return await self._client._call("projection.manifest", arguments)


class _Fs:
    """Filesystem acquisition through the host's ``ctx.fs``."""

    def __init__(self, client):
        self._client = client

    async def capture(self, path, media_type=None, observation_id=None,
                      requested_offset=None, requested_length=None):
        """Capture a file into the artifact store, returning an :class:`Observation`.

        The read goes THROUGH the host's FS backend, so the backend's own authority
        applies and there is no host-path bypass. The model-facing ``read`` tool is
        deliberately not the primitive: its windowing is bounded on purpose, so a
        capture built on it would silently hold fewer bytes while claiming
        completeness.

        :param requested_offset: narrow the captured SCOPE to a byte range. The
            object published is exactly those bytes and the coverage claim is scoped
            to the request, so a partial read can never be read as a whole file.
        """
        arguments = {"path": path}
        if media_type is not None:
            arguments["media_type"] = media_type
        if observation_id is not None:
            arguments["observation_id"] = observation_id
        if requested_offset is not None:
            requested = {"offset": requested_offset}
            if requested_length is not None:
                requested["length"] = requested_length
            arguments["requested_range"] = requested
        payload = await self._client._call("fs.capture", arguments)
        return Observation(self._client, payload)


class _DataClient:
    """The ``dsh.data`` namespace root.

    Holds only the call channel. There is no cache and no state: the host owns the
    observation leases, the cursors and the concurrency bound, so a cell that is
    revoked mid-walk stops paying immediately rather than draining a local buffer.
    """

    def __init__(self, call_async):
        self._call_async = call_async
        self.fs = _Fs(self)
        self.history = _History(self)
        self.web = _Web(self)
        self.artifacts = _Artifacts(self)
        self.projection = _Projection(self)

    async def _call(self, method, arguments):
        """Send one request under the reserved prefix and unwrap the outcome."""
        try:
            payload = await self._call_async(_PREFIX + method, arguments)
        except Exception as exc:
            # The bridge raises BridgeError for a transport-level refusal. Its
            # `code` is already stable, so it is re-raised under this module's own
            # type ONLY when it carries one; otherwise the original is preserved so
            # a caller does not lose the classification.
            code = getattr(exc, "code", None)
            if code is not None:
                raise DataError(code, getattr(exc, "message", str(exc)))
            raise
        # The host's router returns {ok, value} or {ok:false, error:{code,message}}.
        # Both shapes are handled because the bridge may deliver either the router's
        # envelope or its own success value depending on the wiring, and silently
        # treating a refusal envelope as a value would make a failure look like data.
        if isinstance(payload, dict) and payload.get("ok") is False:
            error = payload.get("error") or {}
            raise DataError(error.get("code", "DATA_ERROR"), error.get("message", "the request was refused"))
        if isinstance(payload, dict) and payload.get("ok") is True and "value" in payload:
            return payload["value"]
        return payload

    def _descriptor_of(self, walk):
        """The descriptor a walk was opened with.

        The walk carries the artifact identity, but paging needs the whole
        host-authored descriptor (the cursor is bound to it), so the descriptor is
        read from the walk's own source rather than reconstructed.
        """
        return walk._descriptor

    async def _walk(self, descriptor, max_bytes, max_pages):
        """Open a bounded walk over one captured artifact."""
        arguments = {"descriptor": descriptor, "max_bytes": max_bytes}
        if max_pages is not None:
            arguments["max_pages"] = max_pages
        payload = await self._call("fs.pages", arguments)
        walk = PageWalk(self, payload, max_bytes)
        walk._descriptor = descriptor
        return walk


def install(dsh_module, call_async=None):
    """Install the ``dsh.data`` namespace onto the injected ``dsh`` module.

    Called by the host's per-cell preamble after ``_bind``, so the namespace is
    bound to the CURRENT cell's capability. Rebinding is normal: one kernel serves
    many cells and each gets its own.

    :param dsh_module: the ``dsh`` module the preamble injected.
    :param call_async: the call channel. Omitted, it is read from
        ``dsh_module._channel.call_async``, which is the bridge client's own
        attribute. A missing attribute raises here, at install time, rather than
        producing a namespace whose every method fails later.
    :returns: the installed :class:`_DataClient`.
    """
    if call_async is None:
        channel = getattr(dsh_module, "_channel", None)
        call_async = getattr(channel, "call_async", None)
    if call_async is None:
        raise DataError(
            "DATA_NO_CHANNEL",
            "install() could not find a call channel on the dsh module; the bridge client's "
            "_channel.call_async attribute is missing, so dsh.data cannot be bound",
        )
    client = _DataClient(call_async)
    dsh_module.data = client
    return client
