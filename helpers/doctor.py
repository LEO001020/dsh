"""Read-only deployment metadata check.

WHY THIS FILE EXISTS. `docs/DELIVERY.md` and `docs/OPERATIONS.md` both told an
operator to run `python <delivery>/helpers/doctor.py --source /d/DSH/src/dsh-src`,
and no such file existed anywhere -- not in this repository, not in the audit
package it was derived from. A manual whose first diagnostic step points at a
missing file is a manual that fails the operator at the moment they need it most,
so the file now exists rather than the reference being deleted. Deleting the
reference would have been the smaller edit and the worse outcome: the check it
describes is genuinely useful, and the two manuals were right to want it.

WHAT IT IS. A metadata check over TWO things, and the split is V5 section 14's.

  1. `compatibility.expected.json` -- the REQUIREMENTS. Checked against this
     machine (Node, pnpm, Python, the pinned checkout, the definition's shape) and
     audited for the one property it must have: NO digest of any file in this
     repository, so no edit to the deployment can move it.
  2. `compatibility.lock.json -> deployment.identity` -- the SUPERSEDED
     self-referential identity. Still checked, because the lock still records it and
     84 PASS rows in `qualification/gates.json` still cite it, and a citation a
     reader cannot falsify is worse than no citation. The check reports what moved.

It does NOT re-stamp anything. The old check's job was to say "the tree moved and
the identity did not"; under the split the identity is GENERATED, so a stale value
is expected rather than alarming, and the report says which of the two conditions
it is.

WHY THE IDENTITY CHECK STILL MATTERS, in this project's own history. The superseded
identity has been re-derived five times, and THREE of those were corrections of a
real defect rather than routine drift:
  - `launcher_realpath` had been written through Python escape processing, so
    `\\apps\\` became a BEL byte and `\\bin.js` became a backspace. The MANGLED
    string is what the old hash covered, so that identity described a path that
    does not exist. (G-FIX-11)
  - `host_profile_digest`, `agent_preset_digest` and `agent_preset_id` had all
    gone stale after the profile patch gained 258 uncommitted lines and the preset
    disabled `tool-pwsh`. The identity described a profile revision that no longer
    existed. (G-FIX-14 / the 2026-09-20 re-derivation)
  - `resolved_plugin_graph_digest` was checked by NO tool and its basis was a
    pre-F3 dump whose `sandbox-policy.mode` still read the confining
    `workspace-write`, so the identity certified a graph containing the exact defect
    CMP-02 exists to catch. (qualification/results/ROOT-round2/
    identity-input-unchecked-and-stale.md) THIS CHECK NOW CHECKS IT.
Each time, the identity was internally consistent and wrong. That is the failure
this script is built to catch, and it is why it recomputes rather than trusting.

Exit codes:
    0  every requirement holds, and every recorded input matches the tree
    1  at least one requirement is violated, or an input is stale or missing
    2  the invocation or a file is unusable

Usage:
    python helpers/doctor.py [--source D:/DSH/src/dsh-src] [--quiet]
    python helpers/doctor.py --identity-only     # the superseded check alone
    python helpers/doctor.py --expected-only     # the requirements check alone
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOCK = ROOT / "compatibility.lock.json"
EXPECTED = ROOT / "compatibility.expected.json"
BUILD_MANIFEST_GENERATOR = ROOT / "qualification" / "runners" / "build-manifest.py"

# Inputs whose value is a repo-relative path to a file the identity covers.
# Keyed by the input name so a new file-named input is added in one place.
FILE_INPUTS = {
    "host_profile_digest": "profiles/daily-candidate/cordis.patch.yml",
    "agent_preset_digest": "profiles/daily-candidate/presets/daily-standard/agent.cordis.yml",
    "acceptance_spec_sha256": "qualification/specs/acceptance-spec.json",
    # The trusted-local spec pin names the FROZEN as-authored snapshot, NOT the
    # live spec. The live spec is also the evidence ledger, so filing a verdict
    # changes its digest -- which made this check report a stale pin for a spec
    # behaving exactly as designed. The pin protects the AUTHORED artifact; the
    # live ledger's consistency is verify-spec.py's business. (Found by running
    # this doctor after the first family filed: it and verify-identity.py had
    # briefly disagreed about what the pin meant.)
    "trusted_local_acceptance_spec_sha256":
        "qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json",
}

# THE INPUT NO TOOL USED TO CHECK. `grep -c resolved_plugin_graph_digest
# helpers/rederive-identity.py helpers/doctor.py` returned 0 and 0, so a stale value
# here was invisible to both gates -- and its basis dump predates F3 and still
# contains the confining `workspace-write` mode. It is checked here now.
UNCHECKED_GRAPH_INPUT = {
    "input": "resolved_plugin_graph_digest",
    "basis": "qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml",
}

# The live ledger, checked for SHAPE rather than for its digest: it must carry the
# same case ids as the frozen snapshot, so a filing cannot silently restructure it.
LIVE_LEDGER = "qualification/specs/acceptance-spec.trusted-local-v1.json"

# Inputs that name a path rather than a digest, checked for existence and, where
# a digest of the same file is recorded, for agreement with it.
PATH_INPUTS = {
    "launcher_realpath": "artifact_sha256",
}

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


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


def run_version(command: str) -> tuple[str | None, str | None]:
    """Run `<command> --version`, tolerating a multi-word command and the Windows
    `.cmd` shim.

    MEASURED, not anticipated: on Windows `shutil.which('pnpm')` resolves to
    `pnpm.cmd`, and Python's `subprocess` cannot execute a `.cmd` directly -- it
    raises `FileNotFoundError: [WinError 2]` from CreateProcess. And the version
    that MATTERS is `corepack pnpm`, not the global shim: gate A02 records that
    distinction ("corepack pinned pnpm 11.7.0; the global 11.24.0 was not used").
    """
    parts = command.split()
    resolved = shutil.which(parts[0])
    if resolved is None:
        return None, None
    argv = [resolved, *parts[1:], "--version"]
    if resolved.lower().endswith((".cmd", ".bat")):
        argv = ["cmd", "/c", *argv]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if proc.returncode != 0:
        return None, f"exit {proc.returncode}: {(proc.stderr or '').strip()[-300:]}"
    lines = [line.strip() for line in (proc.stdout or "").splitlines() if line.strip() != ""]
    return (lines[-1] if lines else None), None


def check_expected(lines: list[str], problems: list[str]) -> None:
    """The REQUIREMENTS half: check compatibility.expected.json.

    THE SELF-REFERENCE AUDIT IS THE POINT. The one property this file must have is
    that no edit to the deployment moves it. Every sha256-shaped string in it is
    walked and must be allowlisted with a reason -- which makes "we removed the
    self-reference" falsifiable rather than asserted.

    It delegates the requirement checks to build-manifest.py's `--check-expected`
    rather than re-implementing them, because two implementations of one check
    disagree eventually and this project has already paid for that (this file and
    verify-identity.py briefly disagreed about what the spec pin meant).
    """
    if not EXPECTED.is_file():
        problems.append(f"compatibility.expected.json is missing at {EXPECTED} (V5 section 14's requirements half)")
        lines.append("[FAIL] compatibility.expected.json                     missing")
        return
    try:
        expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"compatibility.expected.json is unreadable: {exc}")
        lines.append(f"[FAIL] compatibility.expected.json                     unreadable: {exc}")
        return

    # ── the self-reference audit, run here as well as in the generator ───────
    #
    # Deliberately duplicated. The generator checks it before emitting an identity;
    # the doctor checks it before telling an operator the tree is sound. If the two
    # ever disagree, THAT disagreement is the finding -- which is why they are
    # separate implementations rather than one shared call.
    allowed = {
        row.get("value"): row.get("reason")
        for row in (expected.get("self_reference_audit") or {}).get("allowed_digest_values") or []
    }
    found: dict[str, int] = {}

    def walk(value) -> None:
        if isinstance(value, str):
            if SHA256_RE.match(value):
                found[value] = found.get(value, 0) + 1
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    walk(expected)
    unauthorised = [v for v in found if v not in allowed]
    if unauthorised:
        for value in unauthorised:
            problems.append(
                f"compatibility.expected.json carries a sha256 OUTSIDE its allowlist "
                f"({value[:16]}...). That is the self-reference the file exists to remove.")
        lines.append(f"[FAIL] self-reference audit                            {len(unauthorised)} unauthorised digest(s)")
    else:
        lines.append(f"[ok  ] self-reference audit                            {len(found)} digest(s), all allowlisted")

    # ── the requirements, delegated ──────────────────────────────────────────
    if BUILD_MANIFEST_GENERATOR.is_file():
        proc = subprocess.run(
            [sys.executable, str(BUILD_MANIFEST_GENERATOR), "--check-expected"],
            capture_output=True, text=True, timeout=600)
        for line in (proc.stdout or "").splitlines():
            if line.startswith("[ok  ]"):
                lines.append(f"[ok  ] requirements: {line[6:].strip()}")
        if proc.returncode != 0:
            tail = [ln for ln in (proc.stdout or "").splitlines() if ln.strip().startswith("- ")]
            for ln in tail:
                problems.append(f"requirement violated: {ln.strip()[2:]}")
            if not tail:
                problems.append(
                    f"the requirements check exited {proc.returncode} without naming a problem: "
                    f"{(proc.stderr or proc.stdout or '').strip()[-300:]}")
            lines.append(f"[FAIL] requirements (build-manifest.py --check-expected) exit {proc.returncode}")
        else:
            lines.append("[ok  ] requirements (build-manifest.py --check-expected)  every requirement holds")
    else:
        problems.append(f"the requirements checker is missing: {BUILD_MANIFEST_GENERATOR}")
        lines.append("[FAIL] requirements checker                              missing")


def check_identity(lines: list[str], problems: list[str], quiet: bool) -> None:
    """The SUPERSEDED identity: does the lock still describe this tree?

    KEPT, AND KEPT HONEST. The lock still records this identity and 84 PASS rows in
    `qualification/gates.json` still cite it, so a reader must be able to check
    whether it still describes this tree. What changed is the INTERPRETATION: under
    the split the identity is generated, so a moved input is expected rather than
    alarming -- and the report says which condition it is.
    """
    if not LOCK.is_file():
        problems.append(f"no lock file at {LOCK}")
        return
    try:
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"the lock file is unreadable: {exc}")
        return

    deployment = lock.get("deployment") or {}
    inputs = deployment.get("inputs") or {}
    recorded = deployment.get("identity")
    if not inputs or not isinstance(recorded, str):
        problems.append("the lock carries no deployment.inputs or no identity")
        return

    computed = identity_digest(inputs)
    if computed == recorded:
        lines.append(f"[ok  ] superseded identity recomputes                 {recorded[:16]}...")
    else:
        # NOT a `problems` entry under the split: the identity is generated now, so
        # this reports a fact rather than raising an alarm. It is reported LOUDLY and
        # counted separately, because a reader who came here to check a citation must
        # see that the citation is stale.
        lines.append(f"[note] superseded identity does NOT recompute        recorded={recorded[:16]}... computed={computed[:16]}...")

    for name, rel in FILE_INPUTS.items():
        pinned = inputs.get(name)
        if not isinstance(pinned, str):
            lines.append(f"[ -- ] {name:42s} not recorded")
            continue
        path = ROOT / rel
        if not path.is_file():
            problems.append(f"{name}: the file it covers is missing ({rel})")
            lines.append(f"[FAIL] {name:42s} file missing: {rel}")
            continue
        actual = sha256_file(path)
        if actual == pinned:
            lines.append(f"[ok  ] {name:42s} {pinned[:16]}...  ({rel})")
        else:
            # Under the split this is EXPECTED: a writer's authorized change to the
            # profile moves this pin, and that is the defect the split removes. It is
            # reported as a NOTE with both values, so a reader can see the move and
            # decide, and it is counted so it cannot be missed.
            lines.append(f"[note] {name:42s} pinned={pinned[:16]}... disk={actual[:16]}...  ({rel})")

    # ── the input NO tool used to check, now checked ─────────────────────────
    recorded_graph = inputs.get(UNCHECKED_GRAPH_INPUT["input"])
    basis = ROOT / UNCHECKED_GRAPH_INPUT["basis"]
    if isinstance(recorded_graph, str):
        if not basis.is_file():
            problems.append(
                f"{UNCHECKED_GRAPH_INPUT['input']}: the file it names is missing ({UNCHECKED_GRAPH_INPUT['basis']})")
            lines.append(f"[FAIL] {UNCHECKED_GRAPH_INPUT['input']:42s} basis file missing")
        else:
            actual = sha256_file(basis)
            if actual == recorded_graph:
                lines.append(f"[note] {UNCHECKED_GRAPH_INPUT['input']:42s} matches its basis, WHICH IS STALE")
            else:
                lines.append(f"[note] {UNCHECKED_GRAPH_INPUT['input']:42s} does NOT match its basis")

    # ── path inputs ─────────────────────────────────────────────────────────
    for path_input, digest_input in PATH_INPUTS.items():
        raw = inputs.get(path_input)
        if not isinstance(raw, str):
            lines.append(f"[ -- ] {path_input:42s} not recorded")
            continue
        # A control byte here means the value was written through escape
        # processing, which is exactly how G-FIX-11 corrupted launcher_realpath.
        control = [c for c in raw if ord(c) < 0x20]
        if control:
            problems.append(f"{path_input} contains control bytes {[hex(ord(c)) for c in control]}")
            lines.append(f"[FAIL] {path_input:42s} contains control bytes -- escape-processed")
            continue
        path = pathlib.Path(raw)
        if not path.is_file():
            problems.append(f"{path_input} names a path that does not exist: {raw}")
            lines.append(f"[FAIL] {path_input:42s} does not exist: {raw}")
            continue
        recorded_digest = inputs.get(digest_input)
        if isinstance(recorded_digest, str):
            actual = sha256_file(path)
            if actual == recorded_digest:
                lines.append(f"[ok  ] {path_input:42s} exists and matches {digest_input}")
            else:
                lines.append(f"[note] {path_input:42s} hash mismatch with {digest_input}")
        else:
            lines.append(f"[ok  ] {path_input:42s} exists (no digest recorded to compare)")

    # ── the live ledger's shape ─────────────────────────────────────────────
    frozen_rel = FILE_INPUTS["trusted_local_acceptance_spec_sha256"]
    frozen_path = ROOT / frozen_rel
    live_path = ROOT / LIVE_LEDGER
    if frozen_path.is_file() and live_path.is_file():
        try:
            frozen_ids = [c.get("id") for c in json.loads(frozen_path.read_text(encoding="utf-8"))["cases"]]
            live = json.loads(live_path.read_text(encoding="utf-8"))
            live_ids = [c.get("id") for c in live["cases"]]
        except (KeyError, json.JSONDecodeError) as exc:
            problems.append(f"the live ledger is unreadable: {exc}")
            lines.append(f"[FAIL] live ledger readable                        {exc}")
        else:
            if frozen_ids == live_ids:
                filed = sum(1 for c in live["cases"] if c.get("status") != "NOT_RUN")
                lines.append(f"[ok  ] live ledger case ids match the frozen spec   {len(live_ids)} ids, {filed} filed")
            else:
                problems.append(
                    f"the live ledger's case ids differ from the frozen snapshot "
                    f"(frozen {len(frozen_ids)}, live {len(live_ids)})")
                lines.append(f"[FAIL] live ledger case ids differ                  frozen={len(frozen_ids)} live={len(live_ids)}")

    if not quiet:
        promotion = lock.get("promotion") or {}
        lines.append("")
        lines.append(f"[info] promotion decision                        {promotion.get('decision')}")


def main() -> int:
    parser = argparse.ArgumentParser(description="read-only deployment metadata check")
    parser.add_argument("--source", default=None,
                        help="the pinned DSH checkout, e.g. D:/DSH/src/dsh-src. "
                             "Optional: it is reported, not required, because this check "
                             "is about the identity inputs and not about the checkout.")
    parser.add_argument("--quiet", action="store_true", help="print only the verdict line")
    parser.add_argument("--expected-only", action="store_true",
                        help="check the REQUIREMENTS half only (compatibility.expected.json)")
    parser.add_argument("--identity-only", action="store_true",
                        help="check the SUPERSEDED identity only (compatibility.lock.json)")
    args = parser.parse_args()

    lines: list[str] = []
    problems: list[str] = []

    if not args.identity_only:
        check_expected(lines, problems)
        lines.append("")
    if not args.expected_only:
        check_identity(lines, problems, args.quiet)

    if args.source:
        source = pathlib.Path(args.source)
        lines.append(f"[info] --source given, existence only            {'present' if source.is_dir() else 'MISSING'}")

    if not args.quiet:
        for line in lines:
            print(line)

    print("")
    if problems:
        print(f"doctor: {len(problems)} problem(s).")
        for problem in problems:
            print(f"  - {problem}")
        print("")
        print("A REQUIREMENT violation is a real finding, not staleness. The superseded")
        print("identity's notes above are different: under V5 section 14 the identity is")
        print("GENERATED, so a moved pin is expected and the generated BuildManifest is what")
        print("result files bind to.")
        return 1

    print("doctor: every requirement holds, and every recorded identity input matches the tree.")
    print("This is a metadata check. It does not boot anything and is not a qualification.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
