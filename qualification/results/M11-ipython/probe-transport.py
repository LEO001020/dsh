"""Probe: what transport can a jupyter_client-started ipykernel actually get on Windows?

Three questions, in order of preference:
  A. IPC transport (jupyter_client transport='ipc') -- audit's first choice.
  B. manager-provisioned CurveZMQ keys with transport_encryption='required'.
  C. default TCP with no encryption (the M0-measured unsafe baseline) -- control.
"""
import json
import os
import sys
import tempfile
import traceback

from jupyter_client import KernelManager

RESULTS = {}


def try_case(label, **km_kwargs):
    entry = {"label": label, "kwargs": {k: v for k, v in km_kwargs.items()}}
    km = None
    try:
        km = KernelManager(**km_kwargs)
        km.start_kernel()
        cf = km.connection_file
        info = json.loads(open(cf, encoding="utf-8").read())
        entry["connection_file"] = cf
        entry["connection_file_keys"] = sorted(info.keys())
        entry["transport"] = info.get("transport")
        entry["curve_publickey_present"] = "curve_publickey" in info
        entry["curve_secretkey_present"] = "curve_secretkey" in info
        entry["key_present"] = bool(info.get("key"))
        kc = km.client()
        kc.start_channels()
        try:
            kc.wait_for_ready(timeout=30)
            msg_id = kc.execute("print(1+1)")
            reply = kc.get_shell_msg(timeout=30)
            entry["shell_reply_status"] = reply["content"]["status"]
            entry["reply_msg_id_matches"] = reply["parent_header"].get("msg_id") == msg_id
            entry["ok"] = True
        finally:
            kc.stop_channels()
    except Exception as exc:  # noqa: BLE001
        entry["ok"] = False
        entry["error_type"] = type(exc).__name__
        entry["error"] = str(exc)[:600]
        entry["traceback"] = traceback.format_exc()[-1200:]
    finally:
        if km is not None:
            try:
                km.shutdown_kernel(now=True)
            except Exception:  # noqa: BLE001
                pass
    return entry


RESULTS["ipc"] = try_case("ipc", transport="ipc")
RESULTS["curve_required"] = try_case("curve_required", transport_encryption="required")
RESULTS["curve_auto"] = try_case("curve_auto", transport_encryption="auto")
RESULTS["tcp_default_control"] = try_case("tcp_default_control")

print(json.dumps(RESULTS, indent=2))
