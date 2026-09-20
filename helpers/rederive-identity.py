#!/usr/bin/env python3
"""Re-derive the deployment identity from the tree, after integration.

WHY THIS EXISTS. The deployment identity is a sha256 over `deployment.inputs`
(artifact, lockfile, profile patch, preset, resolved graph, acceptance spec).
Several of those inputs are DIGESTS OF FILES. So any writer that edits
`profiles/daily-candidate/cordis.patch.yml` or the daily preset or the frozen
spec moves the identity -- and the identity is what every recorded verdict is
bound to. `docs/DELIVERY.md` states the rule plainly: "Any change to any of those
inputs changes the identity and invalidates every PASS recorded against the old
one. That is intended, not a bug."

That makes re-derivation a REQUIRED step after integration, and it makes doing it
by hand dangerous: the identity has been re-derived six times in this project's
history and **two of those were corrections of a real defect rather than routine
drift** (a Windows path mangled by Python escape processing, and a drive-letter
strip added to the preset root). A digest proves the inputs have not changed
since it was computed -- not that they are right. So this tool recomputes and
SHOWS the diff, and refuses to write anything.

WHAT IT DOES NOT DO. It does not decide whether a changed input is CORRECT. It
recomputes the file-derived inputs, reports which moved and by how much, and
prints the new identity. A human-or-root then decides whether each move is
intended (a writer's fix) or a defect (a mangled path). Writing the lock is a
separate, explicit action.

USAGE
    python helpers/rederive-identity.py            # report only
    python helpers/rederive-identity.py --json     # machine-readable
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = ROOT / "compatibility.lock.json"

# Inputs whose value is a digest OF A FILE. Keyed by input name -> repo path.
# A new file-derived input is added here in one place; doctor.py carries the same
# map for its check, and the two are deliberately separate so a mistake in one
# does not silently agree with itself.
FILE_INPUTS = {
    "host_profile_digest": "profiles/daily-candidate/cordis.patch.yml",
    "agent_preset_digest": "profiles/daily-candidate/presets/daily-standard/agent.cordis.yml",
    "acceptance_spec_sha256": "qualification/specs/acceptance-spec.json",
    "trusted_local_acceptance_spec_sha256":
        "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json",
}

# The artifact digest is over the BUILT launcher, not a repo file, so it is
# checked separately against the path the lock itself names.
ARTIFACT_INPUT = "artifact_sha256"
LAUNCHER_INPUT = "launcher_realpath"


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def identity_digest(inputs: dict) -> str:
    """The identity's declared algorithm, quoted from the lock:
    sha256(UTF8(json.dumps(inputs, sort_keys=True, separators=(',', ':'), ensure_ascii=True)))
    """
    payload = json.dumps(inputs, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description="re-derive the deployment identity (read-only)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    deployment = lock.get("deployment", {})
    recorded_inputs = deployment.get("inputs", {})
    recorded_identity = deployment.get("identity")

    if not recorded_inputs:
        print("the lock carries no deployment.inputs; nothing to re-derive", file=sys.stderr)
        return 2

    # Copy, so the recomputation is over exactly the declared input set.
    recomputed = dict(recorded_inputs)
    moves: list[dict] = []

    for name, rel in FILE_INPUTS.items():
        if name not in recomputed:
            continue
        path = ROOT / rel
        if not path.exists():
            moves.append({"input": name, "path": rel, "kind": "MISSING",
                          "recorded": recomputed[name], "computed": None})
            continue
        actual = sha256_file(path)
        if actual != recomputed[name]:
            moves.append({"input": name, "path": rel, "kind": "CHANGED",
                          "recorded": recomputed[name], "computed": actual})
        recomputed[name] = actual

    # The launcher: the lock names a path, and its digest must agree.
    launcher_rel = recorded_inputs.get(LAUNCHER_INPUT)
    if launcher_rel:
        launcher = pathlib.Path(launcher_rel)
        if launcher.exists():
            actual = sha256_file(launcher)
            if actual != recomputed.get(ARTIFACT_INPUT):
                moves.append({"input": ARTIFACT_INPUT, "path": str(launcher),
                              "kind": "CHANGED", "recorded": recomputed.get(ARTIFACT_INPUT),
                              "computed": actual})
            recomputed[ARTIFACT_INPUT] = actual
        else:
            moves.append({"input": ARTIFACT_INPUT, "path": str(launcher), "kind": "MISSING",
                          "recorded": recomputed.get(ARTIFACT_INPUT), "computed": None})

    new_identity = identity_digest(recomputed)

    if args.json:
        print(json.dumps({
            "recorded_identity": recorded_identity,
            "recomputed_identity": new_identity,
            "identity_moved": new_identity != recorded_identity,
            "input_moves": moves,
        }, indent=1))
        return 0

    print(f"recorded identity  : {recorded_identity}")
    print(f"recomputed identity: {new_identity}")
    print()
    if not moves:
        print("no file-derived input moved. The identity is unchanged by this tree.")
    else:
        print(f"{len(moves)} input(s) moved:")
        for m in moves:
            print(f"  {m['input']}")
            print(f"    {m['kind']}: {m['path']}")
            print(f"    recorded: {str(m['recorded'])[:32]}")
            print(f"    computed: {str(m['computed'])[:32]}")
        print()
        print("EVERY VERDICT BOUND TO THE OLD IDENTITY IS NOW STALE. That is intended:")
        print("an identity proves the inputs have not changed, not that they are right.")
        print()
        print("BUT A MOVE IS NOT AUTOMATICALLY A CORRECTION. Two of this project's six")
        print("re-derivations were fixes for real defects (a Windows path mangled by")
        print("Python escape processing; a missing drive-letter strip on the preset root).")
        print("Decide for EACH move whether it is an intended change or a defect, and")
        print("record which. This tool does not write the lock.")
    print()
    print("To adopt the new identity, edit deployment.inputs and deployment.identity in")
    print("compatibility.lock.json deliberately, then run helpers/doctor.py.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
