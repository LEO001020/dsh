"""BRI-WAITER driver: run ONE bridge call with the reader thread's turn FORCED.

WHY A DRIVER AT ALL, AND WHY IT IS DETERMINISTIC.

The defect under test is a scheduling race in the client's `call_sync` /
`call_async`: the waiter is registered AFTER the request has been put on the
wire, so a reply that the reader thread looks up in that window is popped,
found to have no waiter, and DISCARDED -- after which the caller waits out its
whole timeout for an answer that was already delivered.

A test that merely sends a call and hopes to lose the race is not a test. The
window is real but tiny: the reader thread is blocked on `self._lock` holding a
parsed reply while `_send` holds that lock, so the reader is the very next
lock-holder -- but which thread CPython resumes after `release()` is decided by
the eval loop, not by the code. Measured on this machine, the natural run
usually wins. So the interleaving is FORCED here, and the forcing is stated
rather than hidden:

    `SchedulingLock` is installed in place of the client's own `_lock`. It does
    exactly one thing: when the CALLER (never the reader) asks for the lock
    after at least one frame has been sent and the reader has not yet had its
    turn, it waits for the reader's lookup to complete before acquiring.

That is the whole injection. The client's own `_send`, `call_sync`,
`call_async` and `_read_loop` run UNMODIFIED over a REAL loopback socket with a
REAL reader thread, talking to the REAL `BridgeServer` through the REAL
per-cell preamble. `ObservedWaiters` is a recording dict, not a blocking one:
it never changes what the client does, it only records what the reader found.
(It must not block -- the reader pops while HOLDING the lock, so a blocking dict
would deadlock instead of failing.)

WHAT THE DRIVER REPORTS, and which field carries the oracle:

  value / error      the call's own outcome. THE ORACLE: a delivered reply must
                     come back as a value, never as TIMEOUT.
  readerLookups      how many times the reader popped a request id.
  readerLookupsWithoutWaiter
                     how many of those found NOTHING. Non-zero is the defect,
                     observed directly rather than inferred from the timeout.
  registrationSendCount
                     frames already on the wire when the waiter was registered.
                     0 means the waiter existed before the request did.
  forcedWaitMs       how long the barrier held the caller. Non-zero proves the
                     interleaving was actually forced in this run rather than
                     not happening.
  readerWaitExpired  the barrier gave up. Must be False: a True here means the
                     reader never looked anything up, so the run proves nothing.

Run:  python bri-waiter-driver.py <sync|async> <preamble.py> <timeout_s>
Out:  one JSON object on stdout.
"""
import asyncio
import json
import sys
import threading
import time

# How long the caller may be held waiting for the reader's turn. Longer than any
# plausible host round trip (the host is a loopback listener in the same test),
# and short enough that a broken run still reports instead of hanging.
BARRIER_BUDGET_S = 4.0


def _instrument(dsh, fail_send):
    """Install the two observations and the one scheduling hook. Returns state."""
    channel = dsh._channel

    # (0) Force the connection BEFORE instrumenting. `_ensure_locked` performs
    #     the handshake and starts the reader thread, so afterwards the socket
    #     is real, the reader is alive, and no call has been made yet.
    with channel._lock:
        real_sock = channel._ensure_locked()

    state = {
        'sends': 0,
        'readerLookups': 0,
        'readerLookupsWithoutWaiter': 0,
        'callerCleanupPops': 0,
        'registrationSendCount': None,
        'forcedWaitMs': 0.0,
        'readerWaitExpired': False,
        'waitersAfter': 0,
    }
    reader_looked_up = threading.Event()
    # ATTRIBUTED BY THREAD, because both the reader and the caller pop this dict:
    # the reader pops every reply it reads, and the caller pops its own waiter on
    # a timeout (`call_sync`) or in its `finally` (`call_async`). Counting them
    # together would report a caller's cleanup as a discarded reply, which is the
    # opposite of what the field is for. `_ensure_locked` has already started the
    # thread, so its ident is available here.
    reader_ident = channel._reader.ident

    class SendProbe:
        """Records that a frame went out. Everything else is forwarded."""

        def __init__(self, sock, fail):
            self._sock = sock
            self._fail = fail

        def sendall(self, data):
            if self._fail:
                # The `sendfail` mode: a send that raises AFTER the waiter has
                # been registered, which is the arm the cleanup path exists for.
                # An injection, and named as one.
                raise OSError('injected send failure')
            state['sends'] += 1
            return self._sock.sendall(data)

        def __getattr__(self, name):
            return getattr(self._sock, name)

    class ObservedWaiters(dict):
        """A recording `_waiters`. It NEVER blocks -- see the module docstring."""

        def pop(self, key, *default):
            present = dict.__contains__(self, key)
            if threading.get_ident() == reader_ident:
                # The reader looking a reply up. `not present` here is the defect:
                # the reply was delivered and there was no waiter to receive it.
                state['readerLookups'] += 1
                if not present:
                    state['readerLookupsWithoutWaiter'] += 1
                reader_looked_up.set()
            else:
                # The caller clearing up its own registration after a timeout, or
                # the fixed `_send` rolling back a failed send.
                state['callerCleanupPops'] += 1
            return dict.pop(self, key, *default)

        def __setitem__(self, key, value):
            if state['registrationSendCount'] is None:
                state['registrationSendCount'] = state['sends']
            dict.__setitem__(self, key, value)

    class SchedulingLock:
        """The client's lock, with the reader's turn forced before a late re-acquire."""

        def __init__(self, real):
            self._real = real
            self._owner = threading.get_ident()

        def acquire(self, blocking=True, timeout=-1):
            # ONLY the caller is ever held, and only when a request is already
            # in flight whose reply the reader has not yet looked up. The reader
            # is never delayed: delaying it would deadlock, and would also be a
            # different experiment from the one being run.
            if threading.get_ident() == self._owner and state['sends'] > 0 and not reader_looked_up.is_set():
                started = time.monotonic()
                if not reader_looked_up.wait(BARRIER_BUDGET_S):
                    state['readerWaitExpired'] = True
                state['forcedWaitMs'] += (time.monotonic() - started) * 1000.0
            return self._real.acquire(blocking, timeout)

        def release(self):
            self._real.release()

        def __enter__(self):
            self.acquire()
            return self

        def __exit__(self, *exc):
            self.release()
            return False

    channel._waiters = ObservedWaiters()
    channel._socket = SendProbe(real_sock, fail_send)
    channel._lock = SchedulingLock(channel._lock)
    return state


def _call(dsh, mode, timeout_s):
    """One call, sync or async, returning the outcome rather than raising."""
    started = time.monotonic()
    try:
        if mode == 'sync':
            value = dsh.call_sync('probe_echo', {'tag': 'from-the-driver'}, timeout_s)
        else:
            async def run():
                return await dsh.call('probe_echo', {'tag': 'from-the-driver'}, timeout_s)
            value = asyncio.run(run())
        return {'ok': True, 'value': value, 'elapsedMs': (time.monotonic() - started) * 1000.0}
    except BaseException as exc:  # noqa: BLE001 -- the outcome IS the measurement
        return {
            'ok': False,
            'error': {'code': getattr(exc, 'code', type(exc).__name__), 'message': str(exc)},
            'elapsedMs': (time.monotonic() - started) * 1000.0,
        }


def main(argv):
    if len(argv) != 4:
        raise SystemExit('usage: bri-waiter-driver.py <sync|async|sendfail> <preamble.py> <timeout_s>')
    mode, preamble_path, timeout_text = argv[1], argv[2], argv[3]
    if mode not in ('sync', 'async', 'sendfail'):
        raise SystemExit('mode must be sync, async or sendfail')

    # The REAL per-cell preamble, rendered by the REAL BridgeServer, executed
    # exactly as the kernel would: it defines `dsh` in this namespace.
    namespace = globals()
    with open(preamble_path, 'rb') as handle:
        exec(compile(handle.read(), preamble_path, 'exec'), namespace)  # noqa: S102
    dsh = namespace['dsh']

    state = _instrument(dsh, fail_send=(mode == 'sendfail'))
    outcome = _call(dsh, 'sync' if mode == 'sendfail' else mode, float(timeout_text))
    # Whether the failed send left a waiter registered. Zero is the healthy
    # state; a leftover would make a later caller wait for a request that was
    # never sent.
    state['waitersAfter'] = len(dsh._channel._waiters)
    report = {'mode': mode, **outcome, **state}
    sys.stdout.write(json.dumps(report, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
