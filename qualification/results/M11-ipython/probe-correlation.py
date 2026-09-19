"""Does `transport_encryption='required'` break shell reply correlation?

The M3 transport probe recorded `reply_msg_id_matches: false` for
`transport_encryption='required'` while `'auto'` and the default both matched. If
that is real, encryption and correct cell attribution are in tension, and IPY-06
("only the matching reply/idle completes the cell; a foreign frame must not end
it") cannot be satisfied in encrypted mode.

One uncontrolled observation is not enough to decide, so this probe repeats the
sequence N times per mode and records EVERY reply's parent id rather than only
the first. The distinction that matters:

  - If `required` consistently returns a reply whose parent is a DIFFERENT
    request, correlation is broken in that mode.
  - If the mismatch is only that the FIRST message on the channel is something
    else (a `kernel_info_reply` from `wait_for_ready`, say), then correlation is
    fine and the earlier probe was reading a startup frame as the answer.

Those are different findings and the fix differs, so the probe separates them.
"""
import json
import sys
import traceback

from jupyter_client import KernelManager

REPEATS = 5
RESULTS = {}


def drain_shell(kc, timeout=5.0):
    """Collect every shell message available, with its parent id."""
    seen = []
    while True:
        try:
            msg = kc.get_shell_msg(timeout=timeout)
        except Exception:
            break
        seen.append({
            "msg_type": msg["header"]["msg_type"],
            "parent": msg["parent_header"].get("msg_id"),
            "status": (msg.get("content") or {}).get("status"),
        })
    return seen


def probe_mode(label, **km_kwargs):
    entry = {"label": label, "kwargs": {k: v for k, v in km_kwargs.items()}, "runs": []}
    km = None
    try:
        km = KernelManager(**km_kwargs)
        km.start_kernel()
        cf = json.loads(open(km.connection_file, encoding="utf-8").read())
        entry["transport"] = cf.get("transport")
        entry["curve_keys_present"] = "curve_publickey" in cf and "curve_secretkey" in cf
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=60)
            for i in range(REPEATS):
                run = {"i": i}
                msg_id = kc.execute(f"print({i} * 7)")
                run["request_msg_id"] = msg_id
                # The reply that answers THIS request, if correlation works.
                reply = kc.get_shell_msg(timeout=60)
                run["first_msg_type"] = reply["header"]["msg_type"]
                run["first_parent"] = reply["parent_header"].get("msg_id")
                run["first_matches"] = run["first_parent"] == msg_id
                # Anything else already queued, so a startup frame cannot be
                # mistaken for the answer.
                run["drained"] = drain_shell(kc, timeout=0.5)
                entry["runs"].append(run)
        finally:
            kc.stop_channels()
        entry["ok"] = True
        matches = [r["first_matches"] for r in entry["runs"]]
        entry["all_matched"] = all(matches)
        entry["match_count"] = sum(1 for m in matches if m)
    except Exception as exc:  # noqa: BLE001
        entry["ok"] = False
        entry["error_type"] = type(exc).__name__
        entry["error"] = str(exc)[:400]
        entry["traceback"] = traceback.format_exc()[-800:]
    finally:
        if km is not None:
            try:
                km.shutdown_kernel(now=True)
            except Exception:  # noqa: BLE001
                pass
    return entry


RESULTS["default"] = probe_mode("default")
RESULTS["curve_required"] = probe_mode("curve_required", transport_encryption="required")
RESULTS["curve_auto"] = probe_mode("curve_auto", transport_encryption="auto")

print(json.dumps(RESULTS, indent=1))
for name, r in RESULTS.items():
    if not r.get("ok"):
        print(f"# {name}: FAILED {r.get('error_type')}: {r.get('error')}", file=sys.stderr)
        continue
    print(
        f"# {name}: transport={r['transport']} curve={r['curve_keys_present']} "
        f"matched={r['match_count']}/{REPEATS} all={r['all_matched']}",
        file=sys.stderr,
    )
