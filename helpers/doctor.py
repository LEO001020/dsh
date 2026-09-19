"""Read-only deployment metadata check.

WHY THIS FILE EXISTS. `docs/DELIVERY.md` and `docs/OPERATIONS.md` both told an
operator to run `python <delivery>/helpers/doctor.py --source /d/DSH/src/dsh-src`,
and no such file existed anywhere -- not in this repository, not in the audit
package it was derived from. A manual whose first diagnostic step points at a
missing file is a manual that fails the operator at the moment they need it most,
so the file now exists rather than the reference being deleted. Deleting the
reference would have been the smaller edit and the worse outcome: the check it
describes is genuinely useful, and the two manuals were right to want it.

WHAT IT IS. A metadata check. It reads `compatibility.lock.json`, re-derives the
deployment identity from `deployment.inputs`, and verifies every file-named input
against what is on disk. It answers one question: **does the identity in the lock
describe the tree that is actually here?**

WHAT IT IS NOT. It is not a DSH qualification, and it does not boot anything. A
green run here means the recorded inputs still match the files; it says nothing
about whether the deployment works. The gates are the thing that says that, and
`qualification/runners/build-gates.py` generates them from evidence on disk.

WHY THE IDENTITY CHECK MATTERS, in this project's own history. The identity has
been re-derived five times, and THREE of those were corrections of a real defect
rather than routine drift:
  - `launcher_realpath` had been written through Python escape processing, so
    `\\apps\\` became a BEL byte and `\\bin.js` became a backspace. The MANGLED
    string is what the old hash covered, so that identity described a path that
    does not exist. (G-FIX-11)
  - `host_profile_digest`, `agent_preset_digest` and `agent_preset_id` had all
    gone stale after the profile patch gained 258 uncommitted lines and the preset
    disabled `tool-pwsh`. The identity described a profile revision that no longer
    existed. (G-FIX-14 / the 2026-09-20 re-derivation)
Each time, the identity was internally consistent and wrong. That is the failure
this script is built to catch, and it is why it recomputes rather than trusting.

Exit codes:
    0  every recorded input matches the tree
    1  at least one input is stale or missing (the tree moved; the identity did not)
    2  the invocation or the lock file is unusable

Usage:
    python helpers/doctor.py [--source D:/DSH/src/dsh-src] [--quiet]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = ROOT / "compatibility.lock.json"

# Inputs whose value is a repo-relative path to a file the identity covers.
# Keyed by the input name so a new file-named input is added in one place.
FILE_INPUTS = {
    "host_profile_digest": "profiles/daily-candidate/cordis.patch.yml",
    "agent_preset_digest": "profiles/daily-candidate/presets/daily-standard/agent.cordis.yml",
    "acceptance_spec_sha256": "qualification/specs/acceptance-spec.json",
    "trusted_local_acceptance_spec_sha256": "qualification/specs/acceptance-spec.trusted-local-v1.json",
}

# Inputs that name a path rather than a digest, checked for existence and, where
# a digest of the same file is recorded, for agreement with it.
PATH_INPUTS = {
    "launcher_realpath": "artifact_sha256",
}


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
    parser = argparse.ArgumentParser(description="read-only deployment metadata check")
    parser.add_argument("--source", default=None,
                        help="the pinned DSH checkout, e.g. D:/DSH/src/dsh-src. "
                             "Optional: it is reported, not required, because this check "
                             "is about the identity inputs and not about the checkout.")
    parser.add_argument("--quiet", action="store_true", help="print only the verdict line")
    args = parser.parse_args()

    if not LOCK.is_file():
        print(f"doctor: no lock file at {LOCK}", file=sys.stderr)
        return 2
    try:
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"doctor: the lock file is unreadable: {exc}", file=sys.stderr)
        return 2

    deployment = lock.get("deployment") or {}
    inputs = deployment.get("inputs") or {}
    recorded = deployment.get("identity")
    if not inputs or not isinstance(recorded, str):
        print("doctor: the lock carries no deployment.inputs or no identity", file=sys.stderr)
        return 2

    lines: list[str] = []
    problems: list[str] = []

    def say(text: str) -> None:
        lines.append(text)

    # --- 1. the identity recomputes -----------------------------------------
    computed = identity_digest(inputs)
    if computed == recorded:
        say(f"[ok  ] identity recomputes from inputs          {recorded[:16]}...")
    else:
        problems.append(
            f"identity does NOT recompute: recorded {recorded[:16]}... "
            f"computed {computed[:16]}...")
        say(f"[FAIL] identity recomputes from inputs          recorded={recorded[:16]}... computed={computed[:16]}...")

    # --- 2. every file-named input matches disk ------------------------------
    # This is the check that caught three stale inputs on 2026-09-20, so it is the
    # reason the script exists rather than a nicety.
    for name, rel in FILE_INPUTS.items():
        pinned = inputs.get(name)
        if not isinstance(pinned, str):
            say(f"[ -- ] {name:42s} not recorded")
            continue
        path = ROOT / rel
        if not path.is_file():
            problems.append(f"{name}: the file it covers is missing ({rel})")
            say(f"[FAIL] {name:42s} file missing: {rel}")
            continue
        actual = sha256_file(path)
        if actual == pinned:
            say(f"[ok  ] {name:42s} {pinned[:16]}...  ({rel})")
        else:
            problems.append(
                f"{name} is STALE: pinned {pinned[:16]}... but {rel} hashes to {actual[:16]}...")
            say(f"[FAIL] {name:42s} pinned={pinned[:16]}... disk={actual[:16]}...  ({rel})")

    # --- 3. path inputs exist, and agree with their digest where one is recorded
    for path_input, digest_input in PATH_INPUTS.items():
        raw = inputs.get(path_input)
        if not isinstance(raw, str):
            say(f"[ -- ] {path_input:42s} not recorded")
            continue
        # A control byte here means the value was written through escape
        # processing, which is exactly how G-FIX-11 corrupted launcher_realpath.
        control = [c for c in raw if ord(c) < 0x20]
        if control:
            problems.append(f"{path_input} contains control bytes {[hex(ord(c)) for c in control]}")
            say(f"[FAIL] {path_input:42s} contains control bytes -- escape-processed")
            continue
        path = pathlib.Path(raw)
        if not path.is_file():
            problems.append(f"{path_input} names a path that does not exist: {raw}")
            say(f"[FAIL] {path_input:42s} does not exist: {raw}")
            continue
        recorded_digest = inputs.get(digest_input)
        if isinstance(recorded_digest, str):
            actual = sha256_file(path)
            if actual == recorded_digest:
                say(f"[ok  ] {path_input:42s} exists and matches {digest_input}")
            else:
                problems.append(
                    f"{path_input} exists but hashes to {actual[:16]}... while "
                    f"{digest_input} records {recorded_digest[:16]}...")
                say(f"[FAIL] {path_input:42s} hash mismatch with {digest_input}")
        else:
            say(f"[ok  ] {path_input:42s} exists (no digest recorded to compare)")

    # --- 4. the promotion decision, reported rather than judged ---------------
    promotion = lock.get("promotion") or {}
    decision = promotion.get("decision")
    say("")
    say(f"[info] promotion decision                        {decision}")
    say(f"[info] spec                                      {promotion.get('spec_path')}")

    if args.source:
        source = pathlib.Path(args.source)
        say(f"[info] --source given, existence only            {'present' if source.is_dir() else 'MISSING'}")

    if not args.quiet:
        for line in lines:
            print(line)

    print("")
    if problems:
        print(f"doctor: {len(problems)} problem(s). The tree moved and the identity did not:")
        for problem in problems:
            print(f"  - {problem}")
        print("")
        print("Re-derive the identity only after deciding the change is intended, and record")
        print("the superseded values in deployment.identity_history. Every PASS recorded")
        print("against the old identity is invalidated by the new one; that is intended.")
        return 1

    print("doctor: every recorded input matches the tree.")
    print("This is a metadata check. It does not boot anything and is not a qualification.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
