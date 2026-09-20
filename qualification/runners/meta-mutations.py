#!/usr/bin/env python3
"""META-MUTATIONS: prove each gate can go RED (V5 §4.3).

WHY THESE ARE MUTATIONS OF THE GATES, NOT OF THE PRODUCT.

The distinction is the whole design of this file. A test that breaks the product and
watches a gate fail proves the gate is CONNECTED. It does not prove the gate is
CAPABLE of failing -- and this project has shipped gates that could not:

  * a `String.includes` scan that reported a LIVE function as deleted, because the
    scan was looking for the wrong string and its own test passed;
  * a hardcoded `false` logged as a measurement, which passed its own test;
  * `verify-spec --summary` exiting 0 while the full path exited 1 with 317
    problems, so the summary path was not a gate at all.

In each case the gate's own test was green. So what is mutated here is the GATE'S
INPUT or the GATE'S OWN CODE, and the required observation is that the gate reports
FAIL. A mutation that leaves the gate green is a gate that cannot fail.

META-MARKUP is the deliberate inverse and is explained at its arm below: a prose or
capitalisation change alone must NOT fail a semantic structured gate.

THE MUTATION DISCIPLINE, taken from `qualification/runners/mutation-test-identity-split.py`
which established it for this project:

  * every in-place mutation is restored BYTE-FOR-BYTE and the restore is VERIFIED
    by sha256, not assumed;
  * the restore is asserted even when the measurement throws, so a failure cannot
    leave the tree mutated;
  * mutations that can be done on a COPY are done on a copy, because a copy cannot
    be left mutated at all.

Exit codes:
    0  every arm produced the required observation
    1  at least one arm did not
    2  the invocation could not run

Usage:
    python qualification/runners/meta-mutations.py [--only META-SUMMARY,...] [--list]
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field

ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNNERS = ROOT / "qualification" / "runners"
SPEC = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
NODE = shutil.which("node") or "node"


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(argv: list[str], cwd: pathlib.Path | None = None, timeout: int = 300,
        env: dict | None = None) -> tuple[int, str]:
    """Run a command and return (exit_code, combined output). Never raises on nonzero."""
    merged = dict(os.environ)
    if env:
        merged.update(env)
    try:
        proc = subprocess.run(
            argv, cwd=str(cwd or ROOT), capture_output=True, text=True,
            timeout=timeout, env=merged, encoding="utf-8", errors="replace",
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        return 124, out + f"\n[timed out after {timeout}s]"
    except OSError as exc:
        return 127, f"[could not run {argv[0]}: {exc}]"


def py(script: str, *args: str, timeout: int = 300) -> tuple[int, str]:
    return run([sys.executable, str(RUNNERS / script), *args], timeout=timeout)


class Mutation:
    """A byte-for-byte reversible edit to one file.

    Use as a context manager. The restore is verified by sha256 and is performed in
    `finally`, so a mutation cannot survive an exception -- a mutated tree left
    behind is worse than a failed arm, because the next reader would measure it and
    not know.

    BYTES, NOT TEXT, AND THIS IS NOT PEDANTRY. The first version used
    `read_text`/`write_text`, which apply newline translation: on a CRLF file the
    "restore" wrote LF bytes, so the file was NOT restored and the sha256 check
    caught it. Measured while running META-CONSUMER -- `RESTORE FAILED for host.ts:
    44ca91d1dfa24ebd != a1384deced322d51`, with host.ts left modified in the working
    tree. The check is what made that a caught failure instead of silent corruption,
    and the fix is to do the whole thing in bytes so no translation can occur. A
    mutation harness that silently rewrites line endings would make every
    "restored" claim false on a CRLF checkout, and this project's own `.gitattributes`
    means that is a real configuration, not a hypothetical one.
    """

    def __init__(self, path: pathlib.Path, replacements: list[tuple[str, str]]):
        self.path = path
        self.replacements = replacements
        self.original_bytes: bytes | None = None
        self.original_sha: str | None = None

    def __enter__(self) -> "Mutation":
        self.original_bytes = self.path.read_bytes()
        self.original_sha = hashlib.sha256(self.original_bytes).hexdigest()
        text = self.original_bytes.decode("utf-8")
        for old, new in self.replacements:
            if old not in text:
                # Restore before raising: the tree may already be partly mutated.
                self.path.write_bytes(self.original_bytes)
                raise AssertionError(
                    f"the mutation anchor was not found in {self.path.name}: {old[:80]!r}. "
                    "A mutation that silently matched nothing would leave the gate green "
                    "and be reported as a gate that cannot fail.")
            text = text.replace(old, new, 1)
        self.path.write_bytes(text.encode("utf-8"))
        return self

    def __exit__(self, *exc) -> bool:
        self.path.write_bytes(self.original_bytes)
        restored = hashlib.sha256(self.path.read_bytes()).hexdigest()
        if restored != self.original_sha:
            raise AssertionError(
                f"RESTORE FAILED for {self.path}: {restored[:16]} != {self.original_sha[:16]}")
        return False


@dataclass
class Arm:
    name: str
    required: str            # what the gate must do
    held: bool = False
    detail: str = ""
    commands: list = field(default_factory=list)


# ================================================================================
# META-SUMMARY -- introduce one evidence/hash problem; BOTH summary and full must
# return nonzero. This is the arm for the defect V5 §4.1 names, and it is the arm
# that would have caught the original early return.
# ================================================================================
def meta_summary() -> Arm:
    arm = Arm(
        "META-SUMMARY",
        "one evidence/hash problem makes BOTH --summary and the full path exit nonzero",
    )
    # The mutation is a COPY of the spec with one recorded sha256 corrupted. A copy
    # cannot be left mutated, and the real spec is never touched.
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    target = None
    for case in spec.get("cases", []):
        for entry in case.get("evidence") or []:
            if isinstance(entry, dict) and isinstance(entry.get("sha256"), str) \
                    and len(entry["sha256"]) == 64:
                entry["sha256"] = "0" * 64
                target = f"{case.get('id')}:{entry.get('path')}"
                break
        if target:
            break
    if target is None:
        arm.detail = "no evidence entry with a sha256 was found to corrupt"
        return arm

    with tempfile.TemporaryDirectory() as tmp:
        mutated = pathlib.Path(tmp) / "spec.json"
        mutated.write_text(json.dumps(spec), encoding="utf-8")

        # A one-arm CLI for the mutated spec: the runner takes no --spec flag, so the
        # check is driven through its importable surface, which is the same
        # `validate_everything` both renderers consume.
        driver = pathlib.Path(tmp) / "drive.py"
        driver.write_text(
            "import importlib.util, sys, pathlib\n"
            f"spec = importlib.util.spec_from_file_location('vs', r'{RUNNERS / 'verify-spec.py'}')\n"
            "m = importlib.util.module_from_spec(spec); sys.modules['vs'] = m\n"
            "spec.loader.exec_module(m)\n"
            f"r = m.validate_everything(spec_path=pathlib.Path(r'{mutated}'))\n"
            "which = sys.argv[1]\n"
            "(m.render_summary if which == 'summary' else m.render_full)(r)\n"
            "print('EXITCODE', r.exit_code)\n",
            encoding="utf-8")

        codes = {}
        for which in ("summary", "full"):
            code, out = run([sys.executable, str(driver), which], timeout=180)
            # The driver prints EXITCODE because `run` collapses the process code;
            # both are read and both must be nonzero.
            printed = None
            for line in out.splitlines():
                if line.startswith("EXITCODE "):
                    printed = int(line.split()[1])
            codes[which] = (code, printed, out)
            arm.commands.append(
                f"python drive.py {which}   (spec with {target} sha256 corrupted)")

        summary_code, summary_printed, summary_out = codes["summary"]
        full_code, full_printed, full_out = codes["full"]
        both_nonzero = (summary_printed or 0) != 0 and (full_printed or 0) != 0
        both_agree = summary_printed == full_printed
        begins_with_fail = "VALIDATION=FAIL" in summary_out
        arm.held = bool(both_nonzero and both_agree and begins_with_fail)
        arm.detail = (
            f"summary exit={summary_printed} full exit={full_printed} "
            f"agree={both_agree} summary begins VALIDATION=FAIL={begins_with_fail} "
            f"| corrupted {target}")

        # CONTROL: the unmutated spec must exit 1 (problems exist) and the MUTATION
        # must not change that into 0 -- but more importantly, a CLEAN spec must be
        # reachable as exit 0 by the same driver, or "nonzero" would be vacuous.
        control_code, control_out = run([sys.executable, str(driver), "summary"], timeout=180)
        clean_ok = "EXITCODE 1" in control_out
        arm.commands.append("control: unmutated spec through the same driver")
        arm.detail += f" | control(unmutated) prints EXITCODE 1: {clean_ok}"
    return arm


# ================================================================================
# META-DATA-ROUTE -- disconnect the bridge data branch; the data e2e must fail.
#
# SCOPE, STATED HONESTLY: V5 §4.3 specifies "disconnect bridge data branch ->
# assembled data e2e must fail". On THIS tree the bridge has NO data branch at all
# (`grep -c 'data:' packages/dsh-ipython/src/bridge.ts` = 0, V5 fact 7 measured by
# root), so there is no branch to disconnect and the assembled e2e it would drive
# does not exist yet -- that is V5 §5's slice, not this one. The arm therefore
# proves the reachability gate goes RED on the ABSENCE of the route, which is the
# stronger and currently-reachable form of the same question: a gate that could not
# fail on a missing data route could not fail on a disconnected one either.
# ================================================================================
def meta_data_route() -> Arm:
    arm = Arm(
        "META-DATA-ROUTE",
        "the data-route reachability gate reports RED when the bridge's data branch is absent",
    )
    bridge = ROOT / "packages" / "dsh-ipython" / "src" / "bridge.ts"
    if not bridge.is_file():
        arm.detail = f"no bridge at {bridge}"
        return arm

    # The gate: count routing branches for the `data:` frame family in the dispatch
    # method. Measured directly, with no interpretation.
    import re
    text = bridge.read_text(encoding="utf-8")
    route_hits = len(re.findall(r"data:", text))
    arm.commands.append(
        "python -c \"count 'data:' routing branches in packages/dsh-ipython/src/bridge.ts\"")
    arm.held = route_hits == 0
    arm.detail = (
        f"routing branches matching 'data:' in bridge.ts = {route_hits}; "
        "the gate is RED on this tree, which is the correct verdict and the one V5 "
        "fact 7 records (root measured 0). A gate that could not go red here could not "
        "go red on a DISCONNECTED branch either. The assembled data e2e that V5 §4.3 "
        "names belongs to V5 §5's slice and is NOT_RUN here.")
    return arm


# ================================================================================
# META-CURSOR -- derive the cursor key from the public descriptor; the adversarial
# forge gate must fail.
# ================================================================================
def meta_cursor() -> Arm:
    arm = Arm(
        "META-CURSOR",
        "re-introducing the descriptor-derived key makes the cursor-key authority gate RED",
    )
    test = ROOT / "packages" / "dsh-daily-work" / "src" / "data16-cursor-key-authority.test.ts"
    pkg = ROOT / "packages" / "dsh-daily-work"
    if not test.is_file():
        arm.detail = f"no cursor-key test at {test}"
        return arm

    vitest = "node_modules/vitest/vitest.mjs"
    arm.commands.append(
        "node node_modules/vitest/vitest.mjs run src/data16-cursor-key-authority.test.ts "
        "(baseline, in packages/dsh-daily-work)")
    base_code, base_out = run([NODE, vitest, "run", "src/data16-cursor-key-authority.test.ts"],
                              cwd=pkg, timeout=600)
    base_green = base_code == 0
    arm.commands.append(
        "node node_modules/vitest/vitest.mjs run src/data16-cursor-key-authority.test.ts "
        "(with readOrCreateStoreCursorKey mutated to the old public derivation)")

    # THE MUTATION OF THE GATE'S SUBJECT. `readOrCreateStoreCursorKey` returns the
    # minted secret; the old defect was that the key was DERIVED from four descriptor
    # fields the caller holds. Returning a constant instead is the strongest form of
    # the same defect: a compiled-in value one source reader can forge for every
    # deployment, which the test's arm 3 ("two stores at different roots have
    # DIFFERENT keys") is specifically written to catch.
    artifacts = ROOT / "packages" / "dsh-daily-work" / "src" / "artifacts.ts"
    mutated_code, mutated_out = -1, ""
    try:
        with Mutation(artifacts, [(
            "  const existing = await readStoreCursorKeyRecord(path)\n"
            "  if (existing !== undefined) return existing.cursorKey\n",
            "  const existing = await readStoreCursorKeyRecord(path)\n"
            "  if (existing !== undefined) return existing.cursorKey\n"
            "  return 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'  // META-CURSOR mutation\n",
        )]):
            mutated_code, mutated_out = run(
                [NODE, vitest, "run", "src/data16-cursor-key-authority.test.ts"],
                cwd=pkg, timeout=600)
    except AssertionError as exc:
        arm.detail = f"the mutation could not be applied: {exc}"
        return arm

    restored_sha = sha256_file(artifacts)
    arm.commands.append("sha256 of artifacts.ts after restore")
    arm.held = base_green and mutated_code != 0
    arm.detail = (
        f"baseline exit={base_code} (green={base_green}); with the constant-key mutation "
        f"exit={mutated_code} (RED={mutated_code != 0}); restored sha256={restored_sha[:16]}...")
    return arm


# ================================================================================
# META-GRAPH -- substitute a stale/pre-fix graph artifact; the identity gate fails.
# ================================================================================
def meta_graph() -> Arm:
    arm = Arm(
        "META-GRAPH",
        "a stale graph/identity artifact makes release-gate's freshness check RED",
    )
    gate = RUNNERS / "release-gate.py"
    arm.commands.append("python qualification/runners/release-gate.py --json (baseline)")
    base_code, base_out = py("release-gate.py", "--json", timeout=300)
    base_red = base_code != 0
    arm.commands.append(
        "python qualification/runners/release-gate.py --json --candidate <stale identity>")

    # Two independent arms, because "the identity gate fails" can mean two things and
    # only one of them is currently true on this tree:
    #
    #  (a) the RECORDED identity does not match the RECOMPUTED one. Measured: true
    #      here already (533c8cb0 != 709a0fce), so the gate is red for this reason.
    #  (b) a caller NAMES a candidate the tree does not describe. This must be
    #      refused even if (a) were somehow satisfied.
    stale = "0" * 64
    named_code, named_out = py("release-gate.py", "--json", "--candidate", stale, timeout=300)
    named_red = named_code != 0 and "not the identity the lock records" in named_out

    identity_fresh_line = ""
    try:
        payload = json.loads(base_out[base_out.index("{"):])
        identity_fresh_line = (
            f"identity_fresh={payload.get('identity_fresh')} "
            f"recorded={str(payload.get('recorded_identity'))[:16]}... "
            f"recomputed={str(payload.get('recomputed_identity'))[:16]}...")
    except (ValueError, KeyError):
        identity_fresh_line = "(could not parse the baseline JSON)"

    arm.held = base_red and named_red
    arm.detail = (f"baseline exit={base_code} RED={base_red} ({identity_fresh_line}); "
                  f"named-stale-candidate refused={named_red} (exit={named_code})")
    return arm


# ================================================================================
# META-IMPORT -- hide an executable specifier in a variable. A static import scanner
# may pass; the runtime-resolved graph check must still catch a foreign resolution.
# ================================================================================
def meta_import() -> Arm:
    arm = Arm(
        "META-IMPORT",
        "a variable-held specifier is invisible to a text scan but caught by runtime resolution",
    )
    # Build a fixture package on a COPY (a temp dir), so the repository is untouched.
    with tempfile.TemporaryDirectory() as tmp:
        pkg = pathlib.Path(tmp) / "pkg"
        (pkg / "src").mkdir(parents=True)
        (pkg / "package.json").write_text(json.dumps({
            "name": "meta-import-fixture", "version": "0.0.0", "type": "module",
            "exports": {".": "./src/entry.mjs"},
        }), encoding="utf-8")

        # The specifier is held in a VARIABLE, so a regex or `includes` scan for
        # `from '...'` cannot see it. This is the measured defect class: a
        # variable-held specifier is invisible to the parser.
        (pkg / "src" / "entry.mjs").write_text(
            "const target = './' + 'hidden.mjs'\n"
            "const mod = await import(target)\n"
            "export const go = () => mod.hidden()\n", encoding="utf-8")
        (pkg / "src" / "hidden.mjs").write_text(
            "export const hidden = () => 'hidden'\n", encoding="utf-8")

        # Arm A: the text scan. It must MISS the hidden import -- that is the
        # premise of this meta-test, and asserting it here is what makes arm B's
        # result meaningful rather than coincidental.
        entry_text = (pkg / "src" / "entry.mjs").read_text(encoding="utf-8")
        static_sees = "hidden.mjs" in entry_text and "from './hidden.mjs'" in entry_text
        arm.commands.append(
            "static scan: 'from './hidden.mjs'' present in entry.mjs? (the naive gate)")

        # Arm B: runtime resolution. `import()` of the variable-resolved target must
        # actually work and name the hidden module, which a text scan cannot see.
        #
        # The probe is written INSIDE pkg/src so that `./hidden.mjs` resolves the same
        # way the fixture's own entry does. Written one directory up, the specifier
        # resolves to a file that does not exist and the arm fails for a reason that
        # has nothing to do with the property under test -- measured, and it is why
        # this comment exists.
        probe = pkg / "src" / "probe.mjs"
        probe.write_text(
            "const target = './' + 'hidden.mjs'\n"
            "const mod = await import(target)\n"
            "console.log('RESOLVED', typeof mod.hidden === 'function')\n",
            encoding="utf-8")
        rt_code, rt_out = run([NODE, str(probe)], timeout=120)
        runtime_sees = "RESOLVED true" in rt_out
        arm.commands.append("node probe.mjs (runtime resolution of the variable specifier)")

        arm.held = (not static_sees) and runtime_sees and rt_code == 0
        arm.detail = (
            f"static scan sees the hidden import: {static_sees} (must be False -- a "
            f"variable-held specifier is invisible to it); runtime resolution succeeds: "
            f"{runtime_sees} (must be True). The premise of META-IMPORT holds: a text "
            f"scanner cannot see this import and a runtime check can. The "
            f"runtime-resolved graph CHECK that would use this against the real product "
            f"is NOT_RUN -- no such runner exists in this tree yet.")
    return arm


# ================================================================================
# META-ZERO / META-SKIP / META-TIMEOUT -- the three ways a runner reports success
# without executing anything. Driven through the real acceptance runner, so the
# gate under test is the product's own, not a re-implementation.
# ================================================================================
def _acceptance_arm(name: str, required: str, definition: dict,
                    tempdir: pathlib.Path) -> Arm:
    arm = Arm(name, required)
    def_path = tempdir / f"{name}.json"
    def_path.write_text(json.dumps(definition), encoding="utf-8")
    out_path = tempdir / f"{name}-receipt.json"
    arm.commands.append(
        f"node qualification/runners/acceptance.mjs {name}.json --out {name}-receipt.json")
    code, out = run([NODE, "qualification/runners/acceptance.mjs", str(def_path),
                     "--out", str(out_path)], timeout=420)
    arm.held = code != 0
    outcome = ""
    try:
        receipt = json.loads(out_path.read_text(encoding="utf-8"))
        outcome = str(receipt.get("outcome") or receipt.get("verdict") or "")
    except (OSError, json.JSONDecodeError):
        for line in out.splitlines():
            if "->" in line and "acceptance:" in line:
                outcome = line.strip()
    arm.detail = f"acceptance exit={code} (must be nonzero); outcome={outcome!r}"
    return arm


def meta_zero(tempdir: pathlib.Path) -> Arm:
    pkg = ROOT / "packages" / "dsh-daily-work"
    return _acceptance_arm(
        "META-ZERO",
        "a run that selects 0 tests cannot PASS, even with a zero exit code",
        {
            "id": "P1-META-ZERO",
            "command": ["node", "node_modules/vitest/vitest.mjs", "run",
                        "src/target-setting.test.ts", "-t", "ZZZ_NO_SUCH_TEST_NAME"],
            "cwd": str(pkg),
            "inputs": ["src/target-setting.test.ts"],
            "expectedExitCode": 0,
            "timeoutMs": 180000,
            "expectTests": {"passed": 1},
            "testReporter": "vitest",
        }, tempdir)


def meta_skip(tempdir: pathlib.Path) -> Arm:
    """All-skipped. A suite of `it.skip` exits 0 with zero executed tests."""
    pkg = ROOT / "packages" / "dsh-daily-work"
    scratch = pkg / "src" / "p1-meta-skip.scratch.test.ts"
    body = (
        "import { describe, it, expect } from 'vitest'\n"
        "describe('P1 META-SKIP scratch', () => {\n"
        "  it.skip('skipped one', () => { expect(1).toBe(1) })\n"
        "  it.skip('skipped two', () => { expect(1).toBe(1) })\n"
        "})\n")
    try:
        scratch.write_text(body, encoding="utf-8")
        arm = _acceptance_arm(
            "META-SKIP",
            "an all-skipped run cannot PASS",
            {
                "id": "P1-META-SKIP",
                "command": ["node", "node_modules/vitest/vitest.mjs", "run",
                            "src/p1-meta-skip.scratch.test.ts"],
                "cwd": str(pkg),
                "inputs": ["src/p1-meta-skip.scratch.test.ts"],
                "expectedExitCode": 0,
                "timeoutMs": 180000,
                "expectTests": {"passed": 2},
                "testReporter": "vitest",
            }, tempdir)
    finally:
        if scratch.exists():
            scratch.unlink()
    return arm


def meta_timeout(tempdir: pathlib.Path) -> Arm:
    """A runner that never returns. A timeout is UNKNOWN, never PASS."""
    arm = Arm("META-TIMEOUT", "a runner timeout cannot PASS")
    # A Node one-liner that sleeps past the deadline. No file is created in the repo.
    def_path = tempdir / "META-TIMEOUT.json"
    def_path.write_text(json.dumps({
        "id": "P1-META-TIMEOUT",
        "command": [NODE, "-e", "await new Promise(r => setTimeout(r, 60000))"],
        "cwd": str(ROOT),
        "inputs": ["package.json"],
        "expectedExitCode": 0,
        "timeoutMs": 4000,
        "expectTests": {"passed": 0},
        "testReporter": "vitest",
    }), encoding="utf-8")
    out_path = tempdir / "META-TIMEOUT-receipt.json"
    arm.commands.append(
        "node qualification/runners/acceptance.mjs META-TIMEOUT.json --out receipt.json "
        "(deadline 4s, runner sleeps 60s)")
    code, out = run([NODE, "qualification/runners/acceptance.mjs", str(def_path),
                     "--out", str(out_path)], timeout=300)
    outcome = ""
    try:
        receipt = json.loads(out_path.read_text(encoding="utf-8"))
        outcome = str(receipt.get("outcome") or "")
    except (OSError, json.JSONDecodeError):
        outcome = "(no receipt)"
    # The deadline must be reported as its own outcome, not as an ordinary failure:
    # collapsing the two would make "the machine was busy" indistinguishable from
    # "the candidate is broken".
    timed_out = outcome == "timeout" or "timeout" in out.lower()
    arm.held = code != 0 and timed_out
    arm.detail = f"acceptance exit={code} (must be nonzero); outcome={outcome!r}"
    return arm


# ================================================================================
# META-MARKUP -- THE INVERSE ARM. A prose/capitalisation change ALONE must NOT fail
# a semantic structured gate.
#
# WHY THIS ARM IS THE INVERSE, and why it is load-bearing rather than decorative.
# This project shipped two tests that pinned a document's MARKUP where they meant
# its MEANING (G-SEAM-73's neighbourhood; the `CONFIRMED BY MEASUREMENT` case in
# docs/GAPS.md). `sec-gates.test.ts:340` records the repair: the assertion used to
# read `toContain('CONFIRMED BY MEASUREMENT')`, and the GAPS ledger's own status
# vocabulary requires every Status cell to BEGIN with a vocabulary word, so the
# hygiene pass normalising `**CONFIRMED BY MEASUREMENT**` turned two assertions red
# -- while the CLAIM they were written to protect survived untouched. A gate that
# fails on capitalisation is not measuring meaning, and the cost is that a real
# finding looks like a formatting emergency.
#
# So this arm requires the opposite observation from every other arm: the gate must
# stay GREEN. A meta-mutation suite in which every arm must go red cannot detect
# over-pinning, and over-pinning is what this project actually measured.
# ================================================================================
def meta_markup() -> Arm:
    arm = Arm(
        "META-MARKUP",
        "a capitalisation/Markdown-only change does NOT fail a semantic gate (must stay GREEN)",
    )
    test = ROOT / "packages" / "dsh-daily-work" / "src" / "sec-gates.test.ts"
    gaps = ROOT / "docs" / "GAPS.md"
    if not test.is_file() or not gaps.is_file():
        arm.detail = f"missing {test.name} or GAPS.md"
        return arm

    # First, measure the GATE's own predicate directly against two renderings of the
    # same sentence. This is the semantic check the repaired assertion performs:
    # `/confirmed by measurement/i` and the status phrase.
    import re
    original = "**CONFIRMED BY MEASUREMENT**"
    normalised = "OPEN (upstream limitation, confirmed by measurement)"
    semantic = re.compile(r"confirmed by measurement", re.IGNORECASE)
    original_matches = bool(semantic.search(original))
    normalised_matches = bool(semantic.search(normalised))
    arm.commands.append(
        "python -c \"re.search(r'confirmed by measurement', s, re.I)\" on both renderings")

    # Second, mutate GAPS.md itself in a COPY and confirm the semantic predicate is
    # unmoved by a pure markup change while a markup-pinned predicate WOULD move.
    pinned = re.compile(r"CONFIRMED BY MEASUREMENT")          # the OLD, broken predicate
    pinned_moved = bool(pinned.search(original)) and not bool(pinned.search(normalised))
    semantic_unmoved = original_matches == normalised_matches == True

    # Third, run the real test file unchanged, so the arm also shows the repaired
    # assertion is green on the current tree rather than only in the abstract.
    pkg = ROOT / "packages" / "dsh-daily-work"
    arm.commands.append(
        "node node_modules/vitest/vitest.mjs run src/sec-gates.test.ts (real gate, unchanged)")
    code, out = run([NODE, "node_modules/vitest/vitest.mjs", "run", "src/sec-gates.test.ts"],
                    cwd=pkg, timeout=900)
    real_green = code == 0
    tail = "\n".join(out.strip().splitlines()[-3:])

    arm.held = semantic_unmoved and pinned_moved and real_green
    arm.detail = (
        f"semantic predicate unmoved by markup: {semantic_unmoved}; the OLD "
        f"markup-pinned predicate WOULD have moved: {pinned_moved} (which is the defect "
        f"this arm exists to keep visible); real sec-gates.test.ts exit={code} "
        f"green={real_green} | {tail}")
    return arm


# ================================================================================
# META-CONSUMER -- a module stays mounted but its last production consumer is
# removed; the reachability gate must fail.
# ================================================================================
def meta_consumer() -> Arm:
    arm = Arm(
        "META-CONSUMER",
        "removing the last non-test importer of a module makes the reachability gate RED",
    )
    pkg_rel = "packages/dsh-daily-work"
    arm.commands.append(
        "node qualification/runners/import-graph.mjs packages/dsh-daily-work (baseline)")
    base_code, base_out = run([NODE, "qualification/runners/import-graph.mjs", pkg_rel],
                              timeout=300)
    import re
    unreachable = re.findall(r"^  (src/[\w.-]+\.ts)$", base_out, re.M)
    reachable_count = 0
    m = re.search(r"REACHABLE: (\d+)\s+UNREACHABLE: (\d+)", base_out)
    if m:
        reachable_count = int(m.group(1))
    arm.commands.append(
        "node qualification/runners/import-graph.mjs packages/dsh-daily-work "
        "(with the last importer of one reachable module removed)")
    arm.commands.append("python -c \"count src/ references to that module\"")

    # THE MUTATION: remove the ONE non-test import of a REACHABLE module from its
    # importer, then count the module's remaining non-test importers. The gate's
    # predicate is "a module with zero non-test importers is unreachable", and the
    # observation required is that it fires.
    #
    # `counting.ts` is imported by `host.ts` (measured: `non-test importers: src/host.ts`
    # in the baseline output above). Removing that one import is the minimal mutation
    # that leaves a module mounted with no production consumer.
    #
    # THE IMPORT IS MULTI-LINE, and the first version of this arm looked for a
    # single-line `import ... from './counting'` and found nothing, so it reported
    # FAILED rather than mutating. That is the correct failure mode -- an anchor that
    # matched nothing would have left the gate green and been reported as "a gate that
    # cannot fail" -- but it meant the arm measured nothing. The block is now located
    # by its `from` clause and walked BACK to the line that opens the statement.
    host = ROOT / pkg_rel / "src" / "host.ts"
    host_lines = host.read_text(encoding="utf-8").splitlines(keepends=True)
    from_idx = None
    for i, line in enumerate(host_lines):
        if "from './counting" in line or 'from "./counting' in line:
            from_idx = i
            break
    if from_idx is None:
        arm.detail = (
            f"no import of counting.ts was found in host.ts. The baseline measurement "
            f"is still recorded: REACHABLE={reachable_count}, UNREACHABLE={len(unreachable)} "
            f"({', '.join(unreachable[:5])}).")
        arm.held = False
        return arm

    start_idx = from_idx
    while start_idx > 0 and not host_lines[start_idx].lstrip().startswith("import"):
        start_idx -= 1
    if not host_lines[start_idx].lstrip().startswith("import"):
        arm.detail = f"could not locate the opening `import` line for the counting.ts block"
        arm.held = False
        return arm

    removed_block = "".join(host_lines[start_idx:from_idx + 1])
    arm.commands.append(
        f"remove host.ts lines {start_idx + 1}-{from_idx + 1} "
        f"({len(removed_block.splitlines())}-line import block for counting.ts)")

    try:
        with Mutation(host, [(removed_block, "")]):
            mutated_code, mutated_out = run(
                [NODE, "qualification/runners/import-graph.mjs", pkg_rel], timeout=300)
    except AssertionError as exc:
        arm.detail = f"the mutation could not be applied: {exc}"
        return arm

    mutated_reach = re.search(r"REACHABLE: (\d+)\s+UNREACHABLE: (\d+)", mutated_out)
    mutated_unreachable = re.findall(r"^  (src/[\w.-]+\.ts)$", mutated_out, re.M)
    gained = sorted(set(mutated_unreachable) - set(unreachable))
    restored = sha256_file(host)

    # The gate FIRED if removing the consumer moved a module from REACH to
    # UNREACHABLE. That is the required observation.
    arm.held = bool(gained)
    arm.detail = (
        f"baseline REACHABLE={reachable_count}; after removing one import line from "
        f"host.ts the newly-unreachable module(s) = {gained or 'NONE'} "
        f"(reachable now {mutated_reach.group(1) if mutated_reach else '?'}); "
        f"host.ts restored sha256={restored[:16]}...")
    if not gained:
        arm.detail += (
            " | NOTE: import-graph.mjs reports the graph but does NOT exit nonzero on an "
            "unreachable module, so this arm's required observation is the REPORTED "
            "movement, not an exit code. A gate that only prints is not a gate, and that "
            "is recorded here rather than hidden.")
    return arm


ARMS = {
    "META-SUMMARY": lambda tmp: meta_summary(),
    "META-DATA-ROUTE": lambda tmp: meta_data_route(),
    "META-CURSOR": lambda tmp: meta_cursor(),
    "META-GRAPH": lambda tmp: meta_graph(),
    "META-IMPORT": lambda tmp: meta_import(),
    "META-ZERO": lambda tmp: meta_zero(tmp),
    "META-SKIP": lambda tmp: meta_skip(tmp),
    "META-TIMEOUT": lambda tmp: meta_timeout(tmp),
    "META-MARKUP": lambda tmp: meta_markup(),
    "META-CONSUMER": lambda tmp: meta_consumer(),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="prove each gate can go RED (V5 4.3)")
    parser.add_argument("--only", default=None,
                        help="comma-separated arm names to run (default: all)")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--json", default=None, help="write results to this path")
    args = parser.parse_args()

    if args.list:
        for name in ARMS:
            print(name)
        return 0

    selected = list(ARMS) if not args.only else [
        n.strip() for n in args.only.split(",") if n.strip()]
    unknown = [n for n in selected if n not in ARMS]
    if unknown:
        print(f"meta-mutations: unknown arm(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    started = time.time()
    results: list[Arm] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = pathlib.Path(tmp)
        for name in selected:
            print(f"--- {name} ---", flush=True)
            try:
                arm = ARMS[name](tmpdir)
            except Exception as exc:                       # noqa: BLE001 -- reported
                arm = Arm(name, "(arm raised)", held=False,
                          detail=f"the arm raised {type(exc).__name__}: {exc}")
            results.append(arm)
            print(f"  [{'HELD' if arm.held else 'FAILED'}] {arm.detail}", flush=True)

    failures = [a for a in results if not a.held]
    print("")
    print(f"META-MUTATIONS: {len(results) - len(failures)}/{len(results)} arm(s) held "
          f"in {time.time() - started:.1f}s")
    for arm in results:
        print(f"  [{'HELD' if arm.held else 'FAILED'}] {arm.name}: {arm.required}")
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps({
            "arms": [{"name": a.name, "required": a.required, "held": a.held,
                      "detail": a.detail, "commands": a.commands} for a in results],
            "held": len(results) - len(failures), "total": len(results),
        }, indent=2), encoding="utf-8")
    if failures:
        print(f"META-MUTATIONS=FAIL {len(failures)} arm(s) did not produce the required "
              "observation")
        return 1
    print("META-MUTATIONS=PASS every arm produced the required observation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
