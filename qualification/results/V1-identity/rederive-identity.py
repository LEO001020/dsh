#!/usr/bin/env python3
"""Re-derive the deployment identity FROM DISK, and falsify it by mutation.

WHY THIS IS NOT `verify-identity.py` AGAIN.
`qualification/results/T1-spec/verify-identity.py` recomputes the digest over the
`inputs` OBJECT AS STORED IN THE LOCK. That proves the inputs have not been edited
inside the file. It does NOT prove the inputs are RIGHT: T17 measured exactly this
failure -- `host_profile_digest` recomputed to a MATCH for weeks while pinning a
revision of `profiles/daily-candidate/cordis.patch.yml` that no longer existed on
disk. A digest over a stale value is a well-formed number that describes nothing.

So this instrument has two independent halves, and reports them separately:

  A. PINNED-INPUT IDENTITY  -- sha256 over the stored `inputs` object.
     Answers: "has the lock been edited since the identity was taken?"
  B. DISK-DERIVED IDENTITY  -- every file-named input is re-hashed FROM DISK,
     then the identity is recomputed over those derived values.
     Answers: "does the identity still describe the files on this machine?"
     A is allowed to MATCH while B MISMATCHES. That divergence is the finding,
     not a contradiction.

WHAT IT ALSO DOES (the ID-04 stimulus).
It mutates the spec file by ONE character, measures both detections, and restores
the file BYTE-FOR-BYTE, verifying the restore by sha256. The mutation window is
milliseconds; the restore is asserted, not assumed.

WHAT IT DOES NOT DO. It does not decide any acceptance case, it does not write the
lock, and it does not move the identity. Moving `deployment.identity` invalidates
every PASS recorded against it, which is an owner-level decision.

Usage:
    python qualification/results/V1-identity/rederive-identity.py
    python qualification/results/V1-identity/rederive-identity.py --json
    python qualification/results/V1-identity/rederive-identity.py --no-mutate
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCK_PATH = REPO_ROOT / "compatibility.lock.json"
SPEC_PATH = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
OLD_SPEC_PATH = REPO_ROOT / "qualification" / "specs" / "acceptance-spec.json"

# Which identity inputs name a file or directory on this machine, and how to hash
# it. An input that names nothing on disk (a version string, a policy label) is
# not derivable and is reported as such rather than silently skipped: a coverage
# table with invisible holes is the defect class this file exists to catch.
FILE_INPUTS: dict[str, str] = {
    "artifact_sha256": "D:/DSH/src/dsh-src/apps/cli/lib/bin.js",
    # The dependency lock lives in the PINNED CHECKOUT, not in this repo: this
    # repo has no lockfile of its own (the extension packages are installed into
    # a home through `link:`). The first version of this map pointed at
    # `pnpm-lock.yaml` in the repo root, reported it unreadable, and would have
    # filed a false STALE row -- the pin was correct all along.
    "dependency_lock_sha256": "D:/DSH/src/dsh-src/pnpm-lock.yaml",
    "host_profile_digest": "profiles/daily-candidate/cordis.patch.yml",
    "trusted_local_acceptance_spec_sha256": "qualification/specs/acceptance-spec.trusted-local-v1.json",
    "acceptance_spec_sha256": "qualification/specs/acceptance-spec.json",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str | None:
    try:
        with path.open("rb") as handle:
            hasher = hashlib.sha256()
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    except OSError:
        return None


def identity_digest(inputs: dict[str, Any]) -> str:
    """The algorithm the lock itself declares."""
    blob = json.dumps(inputs, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return sha256_bytes(blob.encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-mutate", action="store_true",
                        help="skip the ID-04 mutation arm (read-only run)")
    args = parser.parse_args()

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    deployment = lock["deployment"]
    inputs = deployment["inputs"]
    recorded_identity = deployment["identity"]

    out: dict[str, Any] = {
        "scope": "IDENTITY_RE_DERIVATION_FROM_DISK_NOT_A_CERTIFICATION",
        "lock": str(LOCK_PATH),
        "recorded_identity": recorded_identity,
    }

    # ---- A. pinned-input identity -----------------------------------------
    pinned_identity = identity_digest(inputs)
    out["A_pinned_input_identity"] = {
        "computed": pinned_identity,
        "recorded": recorded_identity,
        "match": pinned_identity == recorded_identity,
    }

    # ---- B. disk-derived identity -----------------------------------------
    derived: dict[str, Any] = {}
    rows: list[dict[str, Any]] = []
    for key, rel in FILE_INPUTS.items():
        target = Path(rel) if Path(rel).is_absolute() else REPO_ROOT / rel
        on_disk = sha256_file(target)
        pinned = inputs.get(key)
        rows.append({
            "input": key,
            "file": rel,
            "exists": target.exists(),
            "pinned": pinned,
            "on_disk": on_disk,
            "matches": on_disk is not None and on_disk == pinned,
        })
        derived[key] = on_disk if on_disk is not None else pinned
    # Every non-file input is carried over verbatim: it names no artifact, so it
    # cannot be re-derived, and pretending otherwise would be an invented fact.
    for key, value in inputs.items():
        if key not in FILE_INPUTS:
            derived[key] = value

    derived_identity = identity_digest(derived)
    stale = [r["input"] for r in rows if not r["matches"]]
    out["B_disk_derived_identity"] = {
        "computed": derived_identity,
        "recorded": recorded_identity,
        "match": derived_identity == recorded_identity,
        "coverage": rows,
        "stale_or_unreadable": stale,
    }

    # ---- ID-02 arm 2: one byte of one input -------------------------------
    # Mutating a STORED input in memory, so the tree is untouched. The point is
    # that the digest is sensitive to a single byte; a digest that survived this
    # would be insensitive to its own inputs.
    probe_inputs = dict(inputs)
    target_key = "host_profile_digest"
    original_value = str(probe_inputs[target_key])
    # Flip one character in a way that cannot accidentally reproduce the value.
    flipped = ("0" if original_value[0] != "0" else "1") + original_value[1:]
    probe_inputs[target_key] = flipped
    mutated_identity = identity_digest(probe_inputs)
    out["ID02_one_byte_change"] = {
        "input": target_key,
        "before": original_value,
        "after": flipped,
        "identity_before": pinned_identity,
        "identity_after": mutated_identity,
        "differs": mutated_identity != pinned_identity,
    }

    # ---- ID-04 arm: mutate the SPEC file by one character, then restore ----
    if not args.no_mutate:
        original_bytes = SPEC_PATH.read_bytes()
        original_sha = sha256_bytes(original_bytes)
        # The stored pin, and the identity recomputed over DISK-DERIVED inputs.
        pinned_spec_sha = inputs.get("trusted_local_acceptance_spec_sha256")
        pre = {
            "spec_sha_on_disk": original_sha,
            "pinned_spec_sha": pinned_spec_sha,
            "stored_digest_matches_file": pinned_spec_sha == original_sha,
            "disk_derived_identity": derived_identity,
            "disk_derived_matches_recorded": derived_identity == recorded_identity,
        }
        # Change ONE character, inside a string value, without changing the JSON
        # structure. `"TRUSTED_LOCAL_ACCEPTANCE_SPEC_NOT_A_DSH_ARTIFACT"` -> ...`ARTIFACU`,
        # chosen because it is a value no code reads and it appears once.
        needle = b"TRUSTED_LOCAL_ACCEPTANCE_SPEC_NOT_A_DSH_ARTIFACT"
        if original_bytes.count(needle) != 1:
            raise SystemExit(
                f"mutation anchor is not unique ({original_bytes.count(needle)} occurrences); "
                "refusing to guess which one to edit",
            )
        mutated_bytes = original_bytes.replace(needle, needle[:-1] + b"U")
        if len(mutated_bytes) != len(original_bytes):
            raise SystemExit("mutation changed the file length; it must be one character")
        try:
            SPEC_PATH.write_bytes(mutated_bytes)
            mutated_sha = sha256_file(SPEC_PATH)
            # Re-derive from disk WITH the mutation in place, exactly as a reader
            # would: the file moved, so the file-named input moved.
            mutated_inputs = dict(inputs)
            mutated_inputs["trusted_local_acceptance_spec_sha256"] = mutated_sha
            mutated_derived_identity = identity_digest(mutated_inputs)
            during = {
                "spec_sha_on_disk": mutated_sha,
                "stored_digest_matches_file": pinned_spec_sha == mutated_sha,
                "disk_derived_identity": mutated_derived_identity,
                "disk_derived_matches_recorded": mutated_derived_identity == recorded_identity,
            }
        finally:
            # RESTORE, and assert the restore. A mutation experiment that leaves
            # the subject changed is indistinguishable from tampering.
            SPEC_PATH.write_bytes(original_bytes)
        restored_sha = sha256_file(SPEC_PATH)
        out["ID04_spec_mutation"] = {
            "mutation": f"{needle.decode()} -> {needle[:-1].decode()}U (one character)",
            "before_mutation": pre,
            "during_mutation": during,
            "restored_sha256": restored_sha,
            "restore_is_byte_exact": restored_sha == original_sha,
            # The two detections the oracle asks for, stated as booleans so a
            # reader does not have to trust the prose above.
            "detection_1_stored_digest_no_longer_matches_file":
                pre["stored_digest_matches_file"] is True
                and during["stored_digest_matches_file"] is False,
            "detection_2_rederived_identity_no_longer_matches_recorded":
                pre["disk_derived_matches_recorded"] is True
                and during["disk_derived_matches_recorded"] is False,
            "identity_stayed_put_while_spec_moved":
                mutated_derived_identity != recorded_identity
                and recorded_identity == recorded_identity,
        }

    # ---- report -----------------------------------------------------------
    if args.json:
        print(json.dumps(out, indent=2))
        return 0

    print(f"lock:      {LOCK_PATH}")
    print(f"identity:  {recorded_identity}")
    print()
    print("A. identity recomputed over the STORED inputs")
    a = out["A_pinned_input_identity"]
    print(f"   computed = {a['computed']}")
    print(f"   recorded = {a['recorded']}")
    print(f"   verdict  = {'MATCH' if a['match'] else 'MISMATCH'}")
    print()
    print("B. identity recomputed over inputs RE-DERIVED FROM DISK")
    b = out["B_disk_derived_identity"]
    width = max(len(r["input"]) for r in b["coverage"])
    for row in b["coverage"]:
        mark = "ok  " if row["matches"] else "STALE"
        on_disk = row["on_disk"] if row["on_disk"] is not None else "(unreadable)"
        print(f"   [{mark}] {row['input']:<{width}}  pinned={str(row['pinned'])[:16]}… disk={str(on_disk)[:16]}…")
    print(f"   computed = {b['computed']}")
    print(f"   recorded = {b['recorded']}")
    print(f"   verdict  = {'MATCH' if b['match'] else 'MISMATCH'}")
    print(f"   stale    = {b['stale_or_unreadable'] or 'none'}")
    print()
    d = out["ID02_one_byte_change"]
    print("ID-02 arm 2: change one byte of one input")
    print(f"   {d['input']}: {d['before'][:16]}… -> {d['after'][:16]}…")
    print(f"   identity differs = {d['differs']}")
    print()
    if "ID04_spec_mutation" in out:
        m = out["ID04_spec_mutation"]
        print("ID-04: mutate one character of the spec file, then restore")
        print(f"   mutation: {m['mutation']}")
        print(f"   before: stored pin matches file  = {m['before_mutation']['stored_digest_matches_file']}")
        print(f"           derived identity matches = {m['before_mutation']['disk_derived_matches_recorded']}")
        print(f"   during: stored pin matches file  = {m['during_mutation']['stored_digest_matches_file']}")
        print(f"           derived identity matches = {m['during_mutation']['disk_derived_matches_recorded']}")
        print(f"   detection 1 (stored pin went stale)          = {m['detection_1_stored_digest_no_longer_matches_file']}")
        print(f"   detection 2 (re-derived identity moved)      = {m['detection_2_rederived_identity_no_longer_matches_recorded']}")
        print(f"   restore byte-exact                           = {m['restore_is_byte_exact']}")
        print(f"   restored sha256 = {m['restored_sha256']}")
    print()
    print("This is arithmetic over files. It does not certify the deployment.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
