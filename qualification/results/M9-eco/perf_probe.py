"""
M9-eco real performance measurement probe.

WHAT THIS IS. Real measurement of local processes: a real ipykernel started
through the real `jupyter_client`, real subprocess spawns, real CPU/RSS from
`psutil`, and a real child boot-storm. Every number it prints is observed on this
machine; none is modelled.

WHAT IT IS NOT. It does not measure a live model provider. There is no
`model blocked time` here in the sense of a provider's first-token latency,
because no provider is authorized (`live_provider_budget_authorized: false` in
`compatibility.lock.json`). The fields that would need one are emitted as
`null` with a reason string, NOT as a zero, so a reader cannot mistake "not
measured" for "measured as instant".

WHY THE PROBE IS A SEPARATE SCRIPT. It needs a real Python interpreter and real
kernel processes, so it cannot run inside the vitest worker without making the
whole suite depend on a Python install. The test that consumes it runs the script
once and asserts on the JSON it produced, so the numbers in the artifact are the
numbers the assertions were made against.

Usage:
    python perf_probe.py <output.json>
"""

import json
import os
import subprocess
import sys
import textwrap
import time
from concurrent.futures import ThreadPoolExecutor

OUT_PATH = sys.argv[1] if len(sys.argv) > 1 else "perf.json"
RESULT = {}

# The stamp makes the frozen artifact self-describing: a reader can see when the
# measurement was taken and on which interpreter, rather than inferring it from
# an mtime that a copy would not preserve.
RESULT["probe_ran_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
RESULT["probe_interpreter"] = sys.executable
RESULT["probe_platform"] = f"{sys.platform} {os.cpu_count()} cpus"


def now_ms():
    """Monotonic milliseconds. `perf_counter` so a clock change cannot corrupt a duration."""
    return time.perf_counter() * 1000.0


def timed(fn):
    """Run `fn` and return (value, milliseconds)."""
    start = now_ms()
    value = fn()
    return value, now_ms() - start


# ---------------------------------------------------------------------------
# 1. Process-helper RTT
# ---------------------------------------------------------------------------

def helper_rtt(argv, n=7):
    """Real spawn + run + exit round trips for one helper command."""
    samples = []
    for _ in range(n):
        start = now_ms()
        subprocess.run(argv, capture_output=True, text=True, check=False)
        samples.append(now_ms() - start)
    return samples


RESULT["process_helper_rtt_ms"] = {
    "python_-c_pass": helper_rtt([sys.executable, "-c", "pass"]),
    "node_-e_0": helper_rtt(["node", "-e", "0"]),
}
RESULT["process_helper_rtt_note"] = (
    "A cold process start per call. These are the numbers that make a "
    "per-observation process helper expensive: at ~30 ms of pure spawn cost, an "
    "observation that shells out once per item pays that per item, which is what "
    "the in-kernel path avoids."
)

# ---------------------------------------------------------------------------
# 2. Local Python ops/sec
# ---------------------------------------------------------------------------

OPS_CODE = textwrap.dedent("""
    import json, time
    N = 2000000
    t = time.perf_counter(); acc = 0
    for i in range(N):
        acc += i * 2
    loop_s = time.perf_counter() - t
    t = time.perf_counter(); acc2 = sum(i * 2 for i in range(N))
    gen_s = time.perf_counter() - t
    t = time.perf_counter(); s = sum(list(range(200000)))
    builtin_s = time.perf_counter() - t
    print(json.dumps({
        "loop_ops_per_s": N / loop_s, "loop_s": loop_s,
        "genexpr_ops_per_s": N / gen_s, "genexpr_s": gen_s,
        "builtin_ops_per_s": 200000 / builtin_s, "builtin_s": builtin_s,
    }))
""")

ops, ops_wall_ms = timed(lambda: subprocess.run(
    [sys.executable, "-c", OPS_CODE], capture_output=True, text=True, check=True,
))
RESULT["local_python_ops"] = json.loads(ops.stdout)
RESULT["local_python_ops_wall_ms"] = ops_wall_ms
RESULT["local_python_ops_note"] = (
    "In-process rates for a pure-Python accumulation loop, a generator "
    "expression, and a builtin sum. The spread between them is the reason a "
    "'local Python ops/sec' figure is meaningless without saying which loop: the "
    "builtin path is several times the interpreted loop."
)

# ---------------------------------------------------------------------------
# 3. Kernel cold start, warm cell RTT, RSS/CPU
# ---------------------------------------------------------------------------

from jupyter_client.manager import KernelManager  # noqa: E402

try:
    import psutil  # noqa: E402
    HAVE_PSUTIL = True
except ImportError:  # pragma: no cover - reported, not hidden
    HAVE_PSUTIL = False


def resource_of(pid):
    """RSS and cumulative CPU for a pid, or a reason string when unavailable."""
    if not HAVE_PSUTIL:
        return {"error": "psutil is not importable; RSS/CPU not measured"}
    try:
        process = psutil.Process(pid)
        with process.oneshot():
            memory = process.memory_info()
            times = process.cpu_times()
            return {
                "rss_bytes": memory.rss,
                "cpu_ms": (times.user + times.system) * 1000.0,
            }
    except Exception as error:  # noqa: BLE001 - reported as a reason, never as zero
        return {"error": f"{type(error).__name__}: {error}"}


def boot_kernel():
    """Start a real kernel and run warm cells. Returns the manager and the samples."""
    start = now_ms()
    manager = KernelManager(kernel_name="python3")
    # CurveZMQ, per M11's transport finding: the default path is plaintext.
    manager.transport_encryption = "required"
    manager.start_kernel(extra_arguments=["--Application.log_level=ERROR"])
    client = manager.client()
    client.start_channels()
    client.wait_for_ready(timeout=120)
    cold_ms = now_ms() - start
    pid = manager.provisioner.process.pid if manager.provisioner else None

    rtts = []
    for index in range(20):
        cell_start = now_ms()
        msg_id = client.execute(f"_eco_x{index} = {index}")
        while True:
            message = client.get_shell_msg(timeout=30)
            if message["parent_header"].get("msg_id") == msg_id:
                break
        rtts.append(now_ms() - cell_start)
    return manager, client, cold_ms, rtts, pid


kernels = []
try:
    cold_starts = []
    warm_rtts = []
    first_pid = None
    rss_samples = []
    for boot in range(5):
        manager, client, cold_ms, rtts, pid = boot_kernel()
        kernels.append((manager, client))
        cold_starts.append(cold_ms)
        warm_rtts.extend(rtts)
        if boot == 0:
            first_pid = pid
            # Sampled AFTER the warm cells, so the figure includes the kernel's
            # steady-state footprint rather than its freshly-booted one.
            rss_samples.append({"label": "after-20-warm-cells", **resource_of(pid)})
        else:
            rss_samples.append({"label": f"boot-{boot + 1}-after-20-warm-cells", **resource_of(pid)})

    RESULT["kernel_cold_start_ms"] = cold_starts
    RESULT["kernel_warm_cell_rtt_ms"] = warm_rtts
    RESULT["kernel_pid_first"] = first_pid
    RESULT["kernel_rss_cpu_samples"] = rss_samples
    RESULT["kernel_note"] = (
        "Cold start is KernelManager construction through wait_for_ready, with "
        "transport_encryption='required' (CurveZMQ). Warm cell RTT is "
        "execute_request to its shell reply for a trivial assignment, measured "
        "from outside the kernel, so it includes the client's own ZMQ and JSON "
        "work rather than only the kernel's."
    )

    # -----------------------------------------------------------------------
    # 4. Child boot-storm
    # -----------------------------------------------------------------------

    def storm(count):
        """Start `count` kernels concurrently and measure the wall time and RSS."""
        start = now_ms()
        made = []
        errors = []

        def one(_):
            try:
                manager = KernelManager(kernel_name="python3")
                manager.transport_encryption = "required"
                manager.start_kernel(extra_arguments=["--Application.log_level=ERROR"])
                client = manager.client()
                client.start_channels()
                client.wait_for_ready(timeout=180)
                return manager, client, None
            except Exception as error:  # noqa: BLE001 - a failure is a result here
                return None, None, f"{type(error).__name__}: {error}"

        with ThreadPoolExecutor(max_workers=count) as pool:
            for manager, client, error in pool.map(one, range(count)):
                if error is None:
                    made.append((manager, client))
                else:
                    errors.append(error)
        wall_ms = now_ms() - start

        total_rss = 0
        rss_reported = 0
        for manager, _client in made:
            pid = manager.provisioner.process.pid if manager.provisioner else None
            if pid is None:
                continue
            sample = resource_of(pid)
            if "rss_bytes" in sample:
                total_rss += sample["rss_bytes"]
                rss_reported += 1

        for manager, client in made:
            try:
                client.stop_channels()
                manager.shutdown_kernel(now=True)
            except Exception:  # noqa: BLE001 - teardown noise must not hide the result
                pass

        return {
            "requested": count,
            "started": len(made),
            "errors": errors,
            "wall_ms": wall_ms,
            "per_kernel_ms": (wall_ms / count) if count else None,
            "rss_total_bytes": total_rss,
            "rss_kernels_reported": rss_reported,
        }

    RESULT["boot_storm"] = [storm(1), storm(5)]
    RESULT["boot_storm_note"] = (
        "Concurrent kernel starts. The 1-kernel row is the control: the ratio "
        "between it and the 5-kernel row is the actual contention, so the "
        "per-kernel figure for the storm is not read as if it were a single boot."
    )

    # -----------------------------------------------------------------------
    # 5. Scheduler refill latency (local): a settle edge to the next admission
    # -----------------------------------------------------------------------

    # Measured in-process, because the scheduler's refill path is a JS function in
    # the host service rather than a kernel operation. The kernel-side figure here
    # is the closest local proxy: the time to have a warm kernel ready to accept
    # the next cell, which is what a refill has to wait for when it starts a
    # replacement child.
    ready_rtts = []
    for index in range(20):
        start = now_ms()
        msg_id = kernels[0][1].execute(f"_eco_refill_{index} = {index}")
        while True:
            message = kernels[0][1].get_shell_msg(timeout=30)
            if message["parent_header"].get("msg_id") == msg_id:
                break
        ready_rtts.append(now_ms() - start)
    RESULT["refill_ready_rtt_ms"] = ready_rtts
    RESULT["refill_ready_note"] = (
        "The kernel-side half of a refill: how long a WARM kernel takes to accept "
        "the next cell. The scheduler's own refill latency is measured in the "
        "TypeScript suite against the real host service; this row is the part of "
        "it that depends on the kernel."
    )
finally:
    for manager, client in kernels:
        try:
            client.stop_channels()
            manager.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001
            pass

# ---------------------------------------------------------------------------
# 6. Fields this probe CANNOT measure, stated rather than zeroed
# ---------------------------------------------------------------------------

RESULT["not_measured"] = {
    "model_blocked_time_ms": {
        "value": None,
        "reason": (
            "requires a live model provider; no budget is authorized "
            "(compatibility.lock.json: live_provider_budget_authorized=false). "
            "Emitted as null, not 0: a zero would read as 'the model answered instantly'."
        ),
    },
    "provider_cache_hit_rate": {
        "value": None,
        "reason": (
            "requires a provider that reports cacheReadTokens on a real request. "
            "A byte-identical prefix is a precondition, not a hit, and DeepSeek's "
            "caching is documented as best-effort."
        ),
    },
    "history_query_latency_ms": {
        "value": None,
        "reason": (
            "requires the session-query service over a populated store; measured "
            "separately in the TypeScript suite against the real SessionQuery, not here."
        ),
    },
    "captured_vs_projected_bytes": {
        "value": None,
        "reason": (
            "measured in the TypeScript suite against the real boundJsonLine, so the "
            "figure is the production bounder's rather than a reimplementation's."
        ),
    },
}

with open(OUT_PATH, "w", encoding="utf-8") as handle:
    json.dump(RESULT, handle, indent=2, sort_keys=True)
    handle.write("\n")

print(json.dumps({
    "wrote": os.path.abspath(OUT_PATH),
    "keys": sorted(RESULT.keys()),
}))
