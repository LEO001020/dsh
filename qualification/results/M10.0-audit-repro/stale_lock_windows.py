#!/usr/bin/env python3
"""Windows reproduction of the audited stale-lock interleaving, plus a Windows-native
exclusive-lock control.

WHY THIS FILE EXISTS. The audit package ships `stale_lock_interleaving.py`, which
imports `fcntl` at module scope. That import fails on Windows before any assertion
runs, so the probe's result was produced on a Unix host and never validated on the
platform this project actually deploys to. The interleaving itself is pure
`os.rename`/`os.link` and is platform-independent, so it is reproduced here
verbatim; only the "stable inode lock" control is re-expressed with `msvcrt`,
which is the Windows equivalent of `flock` for this purpose.

SCOPE: this reproduces the EXTRACTED PROTOCOL, not the DSH WorkService. It proves
the protocol admits two winners under a legal interleaving; it does not by itself
prove the production code path is reachable in that order. The production
regression for that lives in the package's own test suite.
"""
import json
import os
import tempfile
from pathlib import Path


def replace_after_observation(lock_path: Path, who: str) -> str:
    """Move the lock aside and publish a new one, as the production protocol does.

    The point under test: this step never verifies that the file it moves is the
    same file it observed as stale. `os.rename` binds to the NAME, not to the
    identity read earlier, which is exactly the gap.
    """
    aside = lock_path.with_name(f"owner.stale-{who}")
    os.rename(lock_path, aside)
    moved = json.loads(aside.read_text())["token"]
    aside.unlink()
    tmp = lock_path.with_name(f"{who}.tmp")
    tmp.write_text(json.dumps({"token": who, "pid": os.getpid()}))
    os.link(tmp, lock_path)
    tmp.unlink()
    return moved


def run() -> dict:
    events = []
    with tempfile.TemporaryDirectory(prefix="dsh-lock-audit-") as td:
        p = Path(td) / "owner.lock"
        p.write_text(json.dumps({"token": "stale", "pid": 2147483647}))

        # Both contenders complete the read-and-dead-holder check BEFORE either
        # writes. This is the window: both hold the same stale observation.
        seen_a = json.loads(p.read_text())
        seen_b = json.loads(p.read_text())
        events.append({"step": 1, "A_observed": seen_a["token"], "B_observed": seen_b["token"]})

        moved_a = replace_after_observation(p, "A")
        events.append({"step": 2, "owner": "A", "moved": moved_a, "acquired": True})

        # B acts on its ALREADY-COMPLETED stale observation. It never re-reads, so
        # it cannot notice that A published a live lock in the meantime.
        moved_b = replace_after_observation(p, "B")
        events.append({"step": 3, "owner": "B", "moved": moved_b, "acquired": True})

        final_token = json.loads(p.read_text())["token"]
        both_won = moved_a == "stale" and moved_b == "A" and final_token == "B"

        # Control: a lock held on a STABLE file handle (never unlinked, never
        # replaced) refuses a second acquirer. This is what the production fix
        # must adopt, and it is why the fix is "hold an fd", not "add a retry".
        stable = Path(td) / "stable.lock"
        rejected = False
        with stable.open("a+b") as a, stable.open("a+b") as b:
            import msvcrt

            msvcrt.locking(a.fileno(), msvcrt.LK_NBLCK, 1)
            try:
                msvcrt.locking(b.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                rejected = True
            else:
                msvcrt.locking(b.fileno(), msvcrt.LK_UNLCK, 1)
            msvcrt.locking(a.fileno(), msvcrt.LK_UNLCK, 1)

        return {
            "scope": "standalone extracted-protocol interleaving; not DSH integration",
            "platform": os.name,
            "stale_lock_race_reproduced": bool(both_won),
            "both_contenders_return_success": bool(both_won),
            "second_contender_renamed_live_first_lock": moved_b == "A",
            "final_lock_owner": final_token,
            "stable_handle_lock_second_acquisition_rejected": rejected,
            "trace": events,
        }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))
