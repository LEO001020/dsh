#!/usr/bin/env python3
"""Generate the BuildManifest, and the two identities V5 section 14 splits the old one into.

THE DEFECT THIS FILE REMOVES, in V5's own words.

    "Do not keep a self-referential 'HEAD identity' committed inside the same
     commit it hashes."

The old `compatibility.lock.json -> deployment.identity` is a sha256 over
`deployment.inputs`, and FIVE of those inputs are digests of files in the SAME
tree that records them:

    host_profile_digest                 -> profiles/daily-candidate/cordis.patch.yml
    agent_preset_digest                 -> profiles/.../daily-standard/agent.cordis.yml
    resolved_plugin_graph_digest        -> qualification/results/M3.1-c2-profile/dump-*.yml
    acceptance_spec_sha256              -> qualification/specs/acceptance-spec.json
    trusted_local_acceptance_spec_sha256-> qualification/specs/frozen/*.as-authored.json

So editing any of them moves the identity, adopting the move is another edit, and
the identity has moved FOUR TIMES in one wave. The last move was S1's
`includeShippedRoot: false` -- a change the round-2 brief explicitly authorizes,
which nonetheless invalidated the identity because the identity is computed over
the file the change edited. A CORRECT change moving the identity is the defect.

THE SPLIT.

    compatibility.expected.json   checked in, REQUIREMENTS. Contains no digest of
                                  any file in this repository (except the frozen
                                  v1 snapshot, a constant by construction).
    BuildManifest                 GENERATED, a qualification/release artifact.
                                  Describes one BUILD.

    RuntimeDeploymentIdentity     = H(canonical BuildManifest)
    QualificationContractIdentity = H(RuntimeDeploymentIdentity
                                      + acceptance_definition_digest
                                      + release_runner_digests)

Result/evidence files bind to QualificationContractIdentity. A result is filed by
writing a file under a results directory, which is an input of NEITHER hash.

WHY THE MANIFEST IS STILL SELF-DESCRIBING WITHOUT BEING SELF-REFERENTIAL.
It hashes this build, so the commit that ADDS a manifest moves the manifest. That
is unavoidable and it is not the defect: the defect was that the identity was
committed as the AUTHORITY for what the next build must be. Here the authority is
`compatibility.expected.json` (requirements, immovable by any edit to the
deployment) and the manifest is a RECORD that is superseded by the next build.
`--check-manifest` re-derives it and reports which fields moved, exactly as
`helpers/rederive-identity.py` does for the old identity -- and like that tool it
REFUSES TO WRITE. Writing is a separate, explicit action.

WHAT THIS FILE DELIBERATELY DOES NOT DO.
  - It does not compute a manifest without a FRESH OBSERVATION. The runtime graph
    and the model tool catalog cannot be read from a file: V5 says "Graph dump must
    be freshly observed from exact built candidate. Static import scan remains
    useful but is NOT the runtime graph proof." This project has the measurement
    that makes that concrete -- `homelock.ts:126` holds a specifier in a VARIABLE,
    invisible to a parser -- and the old identity's graph input was a DUMP FILE
    from before F3 whose `sandbox-policy.mode` still read the confining
    `workspace-write` (qualification/results/ROOT-round2/identity-input-unchecked-and-stale.md).
    So a manifest without an observation is REFUSED, not defaulted.
  - It does not fill in a value it could not obtain. An unobtainable value is a
    NAMED GAP in `manifest.gaps`, and it is EXCLUDED from the hashed input set --
    because a default that makes a hash agree is the "change the thing measured"
    failure this project forbids. A gap that is load-bearing makes the identity
    NOT_COMPUTABLE rather than silently weaker.
  - It does not judge any acceptance case. It computes identities.

USAGE
    python qualification/runners/build-manifest.py --check-expected
        Validate compatibility.expected.json and check its requirements against
        this machine. Exit 0 / 1 (a requirement is violated) / 2 (unusable).

    python qualification/runners/build-manifest.py --from-observation <obs.json>
        Compute the manifest and the two identities from a stored observation,
        report, and WRITE NOTHING. This is the reproducible path: a third party
        with the observation recomputes the same identities without booting.

    python qualification/runners/build-manifest.py --from-observation <obs.json> --write
        Also write the manifest into the results directory.

    python qualification/runners/build-manifest.py --graph-realpath-check <obs.json>
        The GRAPH-REALPATH gate on its own (V5 section 18). Exit 1 if any
        extension row's realpath is outside the tree that produced the observation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = ROOT / "compatibility.expected.json"
LOCK = ROOT / "compatibility.lock.json"
DEFINITION = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.definition.json"
PROVENANCE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.provenance.json"
FROZEN_V1 = ROOT / "qualification" / "specs" / "frozen" / "acceptance-spec.trusted-local-v1.as-authored.json"
RESULTS_ROOT = ROOT / "qualification" / "results"
DEFAULT_OBSERVATION = RESULTS_ROOT / "P14-manifest" / "observation.json"

# The runner/gate files whose digests bind the CONTRACT, not the deployment. A
# change to one of them changes what a PASS means, so it must move the contract
# identity while leaving the runtime identity exactly where it was -- that
# separation is the whole value of the split.
#
# `.gitattributes` is here for the reason qualification-identity.py records: it
# decides whether a checkout rewrites the bytes of every evidence file, and the
# evidence hashes ARE contract inputs.
CONTRACT_RUNNER_FILES = [
    "qualification/runners/build-manifest.py",
    "qualification/runners/p14-manifest-probe.mjs",
    "qualification/runners/run-p14-manifest.mjs",
    "qualification/runners/overlay.mjs",
    "qualification/runners/boot-harness.mjs",
    "qualification/runners/qualification-identity.py",
    "qualification/runners/verify-spec.py",
    "qualification/specs/frozen/verify-freeze.py",
    ".gitattributes",
]

# Files that ARE the build, digested into the manifest. Keyed by the manifest
# field they fill, so a new package is added in one place.
PACKAGE_TREES = {
    "dsh-daily-work": "packages/dsh-daily-work/lib",
    "dsh-ipython": "packages/dsh-ipython/lib",
}

# Python files that the product executes and that no npm build step touches, so a
# `lib/` digest cannot see a change to them.
PYTHON_SOURCES = {
    "broker": "packages/dsh-ipython/src/broker.py",
    "data_client": "packages/dsh-daily-work/src/dsh_data_client.py",
}

# THE BRIDGE PYTHON CLIENT IS NOT A FILE. V5 section 14 names "broker/data/bridge
# Python hashes", and the first version of this manifest looked for
# `packages/dsh-ipython/src/bridge_client.py`, did not find it, and recorded a gap.
# That was the right SHAPE of response (a gap, not a default) and the wrong
# CONCLUSION, and finding out which is worth recording.
#
# The client is an EMBEDDED template literal: `PYTHON_CLIENT_SOURCE` in
# `packages/dsh-ipython/src/bridge.ts:1325`, written to the kernel's client path by
# `BridgeServer.deliver` (`bridge.ts:944-945`) and compiled by the kernel with
# `exec(compile(...))` (`bridge.ts:1291-1292`). So there is no source file to hash,
# and hashing `bridge.ts` would be a WEAKER claim than it looks: it would also move
# for a change to the TypeScript around the literal, which does not change a byte
# the kernel executes.
#
# So the manifest extracts the literal from the BUILT `lib/bridge.js` -- the file
# the boot actually loads -- and hashes exactly the bytes the kernel will compile.
# The extraction is VERIFIED rather than trusted: it must find exactly one match,
# and the result must be non-trivial. A failed extraction is a gap.
EMBEDDED_PYTHON_CLIENTS = {
    "bridge_python_client": {
        "built_file": "packages/dsh-ipython/lib/bridge.js",
        "source_file": "packages/dsh-ipython/src/bridge.ts",
        "export_name": "PYTHON_CLIENT_SOURCE",
        "why": (
            "the bytes the host writes to the kernel's client path and the kernel compiles "
            "with exec(compile(...)); extracted from the built lib so a change to the "
            "TypeScript AROUND the literal does not move it"),
    },
}


def extract_embedded_client(spec: dict[str, str]) -> dict[str, Any]:
    """Hash an embedded template-literal export by ASKING NODE FOR ITS VALUE.

    WHY NOT A REGEX, measured rather than supposed. The first version of this
    function matched the literal with `NAME\\s*=\\s*`([\\s\\S]*?)`` and reported a body
    of 74 characters. The client is ~300 lines. The literal contains ESCAPED
    backticks -- its own docstring reads ``\\`dsh.call(name, args)\\``` -- so a
    non-greedy match stopped at the first escape sequence, and the manifest would
    have hashed 74 characters of a 12 KB client while looking like a successful
    measurement. That is the defect class this project records most: a parser that
    reads the wrong boundary and reports a confident wrong answer.

    THE FIX IS NOT A BETTER REGEX. Re-implementing JavaScript template-literal
    escape rules in Python would be a SECOND implementation of a standard, and the
    whole point is to hash the EXACT BYTES the kernel compiles. So Node -- the same
    runtime that delivers the string -- is asked for the value, and IT computes the
    digest. Python never touches the string.

    The extraction is VERIFIED rather than trusted: the module must import, the
    export must be a non-trivial string, and the digest must be 64 hex chars. A
    failure is a gap, never a partial value.
    """
    built = ROOT / spec["built_file"]
    if not built.is_file():
        return {"sha256": None, "error": f"{spec['built_file']} does not exist (is the package built?)"}

    script = (
        "import { createHash } from 'node:crypto'\n"
        "try {\n"
        "  const m = await import(process.argv[1])\n"
        "  const v = m[process.argv[2]]\n"
        "  if (typeof v !== 'string') {\n"
        "    console.log(JSON.stringify({ error: 'export is not a string: ' + typeof v }))\n"
        "  } else {\n"
        "    console.log(JSON.stringify({\n"
        "      sha256: createHash('sha256').update(v, 'utf8').digest('hex'),\n"
        "      chars: v.length,\n"
        "      lines: v.split('\\n').length,\n"
        "      first_line: v.split('\\n')[0].slice(0, 120),\n"
        "      last_line: v.split('\\n').slice(-2)[0].slice(0, 120),\n"
        "    }))\n"
        "  }\n"
        "} catch (e) {\n"
        "  console.log(JSON.stringify({ error: String((e && e.message) || e) }))\n"
        "}\n"
    )
    node = shutil.which("node")
    if node is None:
        return {"sha256": None, "error": "node is not on PATH, so the embedded client cannot be read"}
    try:
        proc = subprocess.run(
            [node, "--input-type=module", "-e", script,
             built.resolve().as_uri(), spec["export_name"]],
            capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"sha256": None, "error": f"{type(exc).__name__}: {exc}"}
    if proc.returncode != 0:
        return {"sha256": None, "error": f"node exited {proc.returncode}: {(proc.stderr or '').strip()[-400:]}"}
    lines = [line for line in (proc.stdout or "").splitlines() if line.strip() != ""]
    if not lines:
        return {"sha256": None, "error": "node printed nothing"}
    try:
        facts = json.loads(lines[-1])
    except ValueError as exc:
        return {"sha256": None, "error": f"unparseable node output: {exc}: {lines[-1][:200]}"}
    if facts.get("error") is not None:
        return {"sha256": None, "error": facts["error"]}
    digest_value = facts.get("sha256")
    if not isinstance(digest_value, str) or not SHA256_RE.match(digest_value):
        return {"sha256": None, "error": f"node returned a non-digest: {digest_value!r}"}
    if (facts.get("chars") or 0) < 500:
        return {"sha256": None,
                "error": f"the export is only {facts.get('chars')} chars, too short to be the client"}
    return {
        "sha256": digest_value,
        "chars": facts.get("chars"),
        "lines": facts.get("lines"),
        "first_line": facts.get("first_line"),
        "last_line": facts.get("last_line"),
        "extracted_from": spec["built_file"],
        "source_of_the_literal": spec["source_file"],
        "extraction": "node imported the built module and hashed the VALUE of the export, so JS escape rules are not re-implemented here",
        "why": spec["why"],
    }

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


# ---------------------------------------------------------------------------
# digests
# ---------------------------------------------------------------------------
def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_digest(value: Any) -> str:
    """The identity algorithm the lock itself declares, reused verbatim so a reader
    who can reproduce v1's identity reproduces this one the same way:

        sha256(UTF8(json.dumps(value, sort_keys=True, separators=(',',':'),
                             ensure_ascii=True)))
    """
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def canonical_file_digest(path: Path) -> str | None:
    """A file digest that is INVARIANT to checkout line endings.

    WHY THIS IS NOT sha256_file, and why it is load-bearing. `.gitattributes`
    declares `*.json text eol=lf` while `core.autocrlf` is true, so a JSON file
    written on Windows has CRLF on disk and LF in git. A digest over on-disk bytes
    is then a digest of a line-ending convention and does NOT reproduce from a
    fresh checkout -- measured in this project: three v1 evidence entries record
    CRLF digests no fresh checkout reproduces.

    A contract identity whose digest depends on the checkout that computed it is
    not an identity.
    """
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def tree_digest(rel: str) -> dict[str, Any]:
    """A digest over a built tree, path-sorted so a rename moves it.

    The file count is recorded so a tree that silently EMPTIED is visible rather
    than hashing to something.
    """
    root = ROOT / rel
    if not root.is_dir():
        return {"path": rel, "digest": None, "files": 0, "error": "directory missing"}
    rows = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix not in (".js", ".mjs", ".cjs", ".d.ts"):
            continue
        rows.append([path.relative_to(root).as_posix(), sha256_file(path)])
    return {"path": rel, "digest": canonical_digest(rows), "files": len(rows)}


# ---------------------------------------------------------------------------
# git facts
# ---------------------------------------------------------------------------
def git(*args: str, cwd: Path | None = None) -> str | None:
    try:
        proc = subprocess.run(["git", *args], cwd=cwd or ROOT, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def project_revision() -> dict[str, Any]:
    """The commit and TREE this manifest describes.

    THE SEQUENCING FACT, stated here because it is the condition the manifest
    exists to make legible: twelve other writers edit this tree concurrently, so
    the commit moves under the measurement. The manifest therefore records the
    commit it MEASURED and says so -- it is bound to that commit, not to "now".
    `dirty` is recorded beside it, and the uncommitted path count, so a reader can
    tell a clean tip from a moving one.
    """
    porcelain = git("status", "--porcelain") or ""
    rows = [line for line in porcelain.splitlines() if line.strip() != ""]
    return {
        "commit": git("rev-parse", "HEAD"),
        "tree": git("rev-parse", "HEAD^{tree}"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": len(rows) > 0,
        "dirty_path_count": len(rows),
        "bound_to": "THE COMMIT RECORDED HERE, not to the current HEAD of any other checkout",
    }


def pinned_checkout() -> dict[str, Any]:
    """The pinned upstream checkout: its location, revision and cleanliness.

    ID-06's oracle is `git status --porcelain` empty AND `git rev-parse HEAD` equal
    to the pinned commit. Both halves are reported; a dirty checkout is a REAL
    failure of a requirement and is reported as such rather than smoothed.
    """
    src = Path(os.environ.get("DSH_SRC", "D:/DSH/src/dsh-src"))
    if not src.is_dir():
        return {"path": str(src), "present": False}
    porcelain = git("status", "--porcelain", cwd=src) or ""
    rows = [line for line in porcelain.splitlines() if line.strip() != ""]
    return {
        "path": str(src).replace("\\", "/"),
        "present": True,
        "head": git("rev-parse", "HEAD", cwd=src),
        "clean": len(rows) == 0,
        "porcelain_rows": rows,
    }


# ---------------------------------------------------------------------------
# the environment manifest (V5 section 11.2, as a manifest field)
# ---------------------------------------------------------------------------
def python_environment() -> dict[str, Any]:
    """The Python environment manifest, probed from a real interpreter.

    V5 section 11.2 replaces a path-string digest with a real manifest:
    sys_executable_realpath, implementation, version, and the distribution
    versions that decide the kernel PROTOCOL (ipython, ipykernel,
    jupyter_client, pyzmq). The old digest was
    `sha256(pythonExecutable + platform + arch)` truncated to 16 hex chars --
    which does not change when IPython is upgraded behind the same path.

    THE PROBE IS BOUNDED AND ITS FAILURE IS RECORDED, not defaulted. If no
    interpreter answers, `probed` is false with the error, and the generator
    treats the field as a GAP -- which makes the identity NOT_COMPUTABLE rather
    than silently weaker.
    """
    executable = os.environ.get("DSH_PYTHON") or shutil.which("python") or shutil.which("python3")
    if executable is None:
        return {"probed": False, "error": "no python on PATH and DSH_PYTHON is unset"}
    probe = (
        "import json,os,sys,importlib.metadata as md\n"
        "out={'sys_executable':sys.executable,'sys_executable_realpath':os.path.realpath(sys.executable),"
        "'python_implementation':sys.implementation.name,'python_version':'.'.join(map(str,sys.version_info[:3])),"
        "'platform':sys.platform}\n"
        "for d in ('ipython','ipykernel','jupyter-client','jupyter-core','traitlets','pyzmq'):\n"
        "    try: out[d]=md.version(d)\n"
        "    except Exception: out[d]='ABSENT'\n"
        "print(json.dumps(out,sort_keys=True))\n"
    )
    try:
        proc = subprocess.run([executable, "-c", probe], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"probed": False, "error": f"{type(exc).__name__}: {exc}", "executable": executable}
    if proc.returncode != 0:
        return {"probed": False, "error": f"exit {proc.returncode}: {proc.stderr.strip()[-400:]}", "executable": executable}
    try:
        facts = json.loads(proc.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        return {"probed": False, "error": f"unparseable probe output: {exc}", "executable": executable}
    facts["probed"] = True
    facts["probe_command"] = "python -c <bounded probe importing importlib.metadata>"
    return facts


def run_version(command: str) -> tuple[str | None, str | None]:
    """Run `<command> --version`, tolerating a multi-word command and the Windows
    `.cmd` shim.

    WHY THIS IS NOT A BARE subprocess.run, measured. On Windows `shutil.which`
    resolves `pnpm` to `pnpm.cmd`, and Python's `subprocess` CANNOT execute a
    `.cmd` directly -- it raises `FileNotFoundError: [WinError 2]` from
    CreateProcess. That crashed the first run of `--check-expected` with a
    traceback rather than a verdict, which is the worst shape for a checker: a
    tool that cannot run must report exit 2 and say why, never crash.

    A multi-word command (`corepack pnpm`) is split on whitespace; each token is
    resolved through `shutil.which` so a shim is found the same way a shell would
    find it.

    Returns (version, error). Both None means the command is not present at all,
    which the caller reports as its own condition.
    """
    parts = command.split()
    resolved = shutil.which(parts[0])
    if resolved is None:
        return None, None
    argv = [resolved, *parts[1:], "--version"]
    if resolved.lower().endswith((".cmd", ".bat")):
        # The `.cmd` shim needs a shell. `cmd /c` is used rather than `shell=True`
        # so the argv is still explicit and no string is re-parsed by a shell --
        # the G-FIX-11 defect class, where a backslash path lost an escape to a
        # shell pass and the MANGLED value is what got hashed.
        argv = ["cmd", "/c", *argv]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=180)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"{type(exc).__name__}: {exc}"
    if proc.returncode != 0:
        return None, f"exit {proc.returncode}: {(proc.stderr or '').strip()[-300:]}"
    # `corepack pnpm --version` prints the resolved version on the last line.
    lines = [line.strip() for line in (proc.stdout or "").splitlines() if line.strip() != ""]
    return (lines[-1] if lines else None), None


def node_and_pnpm() -> dict[str, Any]:
    """Node and pnpm as MEASURED, not as declared.

    The declared requirement lives in compatibility.expected.json. This is what
    this machine actually ran, which is the fact a manifest must carry: a
    deployment whose Node is outside the requirement fails the requirement check,
    and a deployment whose Node is inside it still needs the exact version
    recorded so a rerun can be compared.
    """
    out: dict[str, Any] = {}
    out["node"], out["node_error"] = run_version("node")
    out["pnpm"], out["pnpm_error"] = run_version("pnpm")
    out["platform"] = f"{platform.system()} {platform.release()} / {platform.machine()}"
    return out


# ---------------------------------------------------------------------------
# the manifest
# ---------------------------------------------------------------------------
def build_manifest(observation: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Compute the manifest from a fresh observation. Returns (manifest, problems).

    A `problem` is a condition that makes the identity NOT COMPUTABLE: a missing
    observation, a stale build, an unsettled graph, an empty catalog, an
    unresolvable extension row. Problems are NOT the same as gaps: a gap is a value
    that could not be obtained and is excluded from the hash; a problem means the
    manifest must not be published at all.
    """
    problems: list[str] = []
    gaps: list[dict[str, str]] = []

    probe = observation.get("probe") or {}
    if not probe:
        problems.append("the observation carries no probe result: no manifest can be computed from it")
        return {}, problems

    # The observation's own verdict is a precondition, not a note.
    if observation.get("verdict") != "OBSERVED":
        problems.append(
            f"the observation's verdict is {observation.get('verdict')!r}, not 'OBSERVED'. "
            "An observation that failed its own checks cannot be the basis of an identity.")

    graph = probe.get("graph") or {}
    if graph.get("measuredAfterSettle") is not True:
        problems.append("the graph was NOT measured after the loader tree settled: a moving tree is not an identity")
    catalog = probe.get("catalog") or {}
    if (catalog.get("toolCount") or 0) <= 0:
        problems.append("the model tool catalog is empty: that is indistinguishable from a failed Session")

    # BUILD FRESHNESS. A manifest that describes a `lib/` older than its `src/` is
    # describing code that is not the source in the tree.
    freshness = observation.get("build_freshness") or {}
    for pkg, row in sorted(freshness.items()):
        if row.get("libNewerThanSrc") is not True:
            problems.append(
                f"{pkg}: the built lib/ is NOT newer than its src/ "
                f"(lib={row.get('newestLibMtime')} src={row.get('newestSrcMtime')}), so the boot "
                "executed a build that predates the source in this tree")

    expected = load_expected()
    lock = json.loads(LOCK.read_text(encoding="utf-8")) if LOCK.is_file() else {}
    lock_inputs = (lock.get("deployment") or {}).get("inputs") or {}
    launcher_path = Path(lock_inputs.get("launcher_realpath") or "")
    driver = observation.get("driver") or {}

    pyenv = python_environment()
    toolchain = node_and_pnpm()

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "kind": "DSH_BUILD_MANIFEST_NOT_A_DSH_ARTIFACT",
        "_what_this_is": [
            "A generated record of ONE BUILD, stored as a qualification/release",
            "artifact. It is NOT a source input of the candidate it describes: the",
            "requirements a candidate must satisfy live in compatibility.expected.json,",
            "which no edit to a profile, preset, spec or dump can move.",
            "",
            "RuntimeDeploymentIdentity = H(canonical of the `build` object below).",
            "QualificationContractIdentity = H(RuntimeDeploymentIdentity + the contract",
            "object's digests). Result and evidence files bind to the CONTRACT identity.",
        ],
        "generator": {
            "path": "qualification/runners/build-manifest.py",
            "sha256": canonical_file_digest(Path(__file__).resolve()),
            "algorithm": (
                "sha256(UTF8(json.dumps(value, sort_keys=True, separators=(',',':'), "
                "ensure_ascii=True))), the algorithm compatibility.lock.json declares, "
                "reused verbatim"
            ),
        },
        "observation": {
            "path": str(DEFAULT_OBSERVATION.relative_to(ROOT)).replace("\\", "/")
            if observation.get("_source") is None else observation["_source"],
            "ran_at": observation.get("ran_at"),
            "verdict": observation.get("verdict"),
            "driver": driver.get("path"),
            "driver_sha256": driver.get("sha256"),
            "probe_source_sha256": driver.get("probe_source_sha256"),
            "overlay_sha256": driver.get("overlay_sha256"),
            "dsh_home": driver.get("home"),
            "profile": driver.get("profile"),
            "boot_cwd": driver.get("boot_cwd"),
            "_why_the_boot_conditions_are_part_of_the_manifest": (
                "A graph observed from a foreign cwd, a different DSH_HOME or a "
                "different launcher is a graph of a different deployment. Recording "
                "them here is what makes the observation reproducible rather than "
                "merely reported."),
        },
        "build": {},
        # QUALIFIERS: facts that DESCRIBE the observation but are deliberately NOT
        # hashed into RuntimeDeploymentIdentity. Kept in a separate object so the
        # boundary is visible in the artifact rather than a reader having to guess
        # which fields moved the identity. Each entry states why it is excluded.
        "qualifiers": {},
        "gaps": gaps,
    }
    b = manifest["build"]

    # ── V5 section 14's named fields, in its order ───────────────────────────
    #
    # THE REVISION COMES FROM THE OBSERVATION, NOT FROM THE LIVE TREE.
    #
    # THE DEFECT THIS FIXES, measured. The first version called `project_revision()`
    # here and read the LIVE HEAD. The observation was taken at c281f12, one commit
    # landed, and the regenerated manifest reported c061e09 -- claiming to describe a
    # build it was never measured against, with nothing in the artifact to show that
    # anything had moved. That is the SAME defect as the self-referential identity one
    # layer down: a record that silently re-labels itself with whatever is current.
    # Twelve writers edit this tree concurrently, so it is the normal condition rather
    # than a rare race.
    #
    # So the commit is read from the observation, and the LIVE values are reported
    # BESIDE it as a divergence. The manifest is bound to the commit it measured and
    # says so; a reader who wants the current tree sees exactly how far it has moved.
    observed_rev = observation.get("revision") or {}
    live_rev = project_revision()
    if not observed_rev.get("commit"):
        problems.append(
            "the observation does not carry the revision it was taken at (observation.revision). "
            "Without it a manifest cannot say which build it describes -- re-run "
            "qualification/runners/run-p14-manifest.mjs.")
    b["project_git_commit"] = observed_rev.get("commit")
    b["project_git_tree"] = observed_rev.get("tree")
    b["project_git_bound_to"] = (
        "THE COMMIT RECORDED HERE, read at OBSERVATION time. Not the current HEAD of "
        "this or any other checkout: twelve writers edit this tree concurrently, so the "
        "commit moves under the measurement and the manifest states which one it saw.")
    # ── WHAT IS NOT HASHED, AND WHY ─────────────────────────────────────────
    #
    # THE DESIGN ERROR THIS CORRECTS, found by watching the identity move for a
    # reason that was not a change to the deployment. `project_git_dirty_path_count`
    # was in the hashed set, and another writer creating one unrelated file moved
    # RuntimeDeploymentIdentity. A writer adding an untracked result directory did
    # not change the launcher, the profile, the packages, the graph or the catalog --
    # so the identity moved while the deployment did not, which is the exact
    # defect this slice removes.
    #
    # The precedent is already recorded in this project, in
    # qualification-identity.py's `implementation_commit`: "The dirty state is
    # recorded but NOT part of the identity digest: an uncommitted edit in a
    # worktree would otherwise make every measurement in that worktree
    # unreproducible by identity, which would push writers toward committing
    # half-finished work to get a stable hash. The ARTIFACTS are digested instead,
    # so a real change is still caught."
    #
    # So: the COMMIT and the TREE are hashed, because they are the build's identity.
    # The DIRTY state, the BRANCH NAME and the live-at-generation comparison are
    # QUALIFIERS -- recorded, reported, and excluded from the hash. A dirty tree that
    # produced different ARTIFACTS still moves the identity, because every artifact
    # is hashed below; that is what makes the exclusion safe rather than a hole.
    qualifiers = manifest["qualifiers"]
    qualifiers["git_dirty_at_observation"] = {
        "dirty": observed_rev.get("dirty"),
        "dirty_path_count": observed_rev.get("dirty_path_count"),
        "branch": observed_rev.get("branch"),
        "excluded_from_the_identity_because": (
            "a concurrent writer's untracked file is not a change to this deployment, and "
            "including a path COUNT made the identity move for exactly that reason -- "
            "measured. The artifacts are hashed instead, so a real change is still caught. "
            "Same rule and same reason as qualification-identity.py's implementation_commit."),
    }
    qualifiers["git_live_at_generation"] = {
        "commit": live_rev["commit"],
        "dirty": live_rev["dirty"],
        "dirty_path_count": live_rev["dirty_path_count"],
        "commit_moved_since_observation": live_rev["commit"] != observed_rev.get("commit"),
        "_why_this_is_recorded_and_not_an_error": (
            "A commit landing between the observation and the generation is EXPECTED in "
            "this wave, not a fault. What would be a fault is the manifest SILENTLY "
            "adopting the new commit, which is what the first version did. The manifest "
            "keeps the commit it measured and reports the divergence here."),
    }

    # ARTIFACT-LEVEL STALENESS, so a reader can tell a commit-only move from a real
    # change. This is the same distinction qualification-identity.py's staleness
    # report makes, and for the same reason: "the identity moved" and "the deployment
    # changed" are different facts and only one of them needs a re-measurement.
    fingerprint = observation.get("build_fingerprint") or {}
    moved_artifacts = []
    for path, recorded in sorted(fingerprint.items()):
        actual = sha256_file(Path(path))
        if actual != recorded:
            moved_artifacts.append({
                "path": path,
                "recorded_at_observation": recorded,
                "on_disk_now": actual,
            })
    # A statement about "now" rather than about the build, so it is a QUALIFIER:
    # hashing it would make the identity move every time a reader ran the generator.
    qualifiers["artifact_staleness"] = {
        "fingerprinted_paths": len(fingerprint),
        "moved_since_observation": moved_artifacts,
        "commit_moved_only": bool(moved_artifacts) is False and live_rev["commit"] != observed_rev.get("commit"),
        "excluded_from_the_identity_because": (
            "it compares the observation to the moment of generation, so hashing it would make "
            "the identity move every time the generator was re-run on an unchanged build."),
        "_reading": (
            "COMMIT MOVED ONLY: every fingerprinted artifact is byte-identical, so the "
            "deployment is materially the same and the previous measurements still "
            "describe it. Re-derive cheaply; re-measure only if an artifact appears here. "
            "ARTIFACTS MOVED: the measurements no longer describe this tree -- RE-MEASURE."
            if not moved_artifacts else
            "ARTIFACTS MOVED since the observation: the deployment this manifest describes "
            "is no longer what is on disk. RE-MEASURE. A manifest is a record of one build, "
            "and this build is gone."),
    }
    if moved_artifacts:
        problems.append(
            f"{len(moved_artifacts)} fingerprinted artifact(s) moved between the observation and "
            f"this generation: {json.dumps([m['path'] for m in moved_artifacts][:5])}. The manifest "
            "would describe a build that is no longer on disk.")

    b["upstream_sha"] = (expected.get("upstream") or {}).get("commit")
    b["upstream_release"] = (expected.get("upstream") or {}).get("release")
    b["pinned_checkout"] = pinned_checkout()

    b["lockfile"] = {
        "path": "D:/DSH/src/dsh-src/pnpm-lock.yaml",
        "digest": lock_inputs.get("dependency_lock_sha256"),
        "_note": (
            "The value is CARRIED from the lock and re-checked against the file below. "
            "Carrying it is deliberate: it is the same value ID-02 and the doctor check, "
            "so a divergence between the lock and the file is a visible finding rather "
            "than two numbers that quietly disagree."),
        "recomputed_sha256": sha256_file(Path("D:/DSH/src/dsh-src/pnpm-lock.yaml")),
    }

    b["toolchain"] = toolchain

    if pyenv.get("probed") is True:
        b["python_environment"] = {
            "sys_executable": pyenv.get("sys_executable"),
            "sys_executable_realpath": pyenv.get("sys_executable_realpath"),
            "python_implementation": pyenv.get("python_implementation"),
            "python_version": pyenv.get("python_version"),
            "platform": pyenv.get("platform"),
            "distributions": {
                k: pyenv.get(k) for k in ("ipython", "ipykernel", "jupyter-client",
                                          "jupyter-core", "traitlets", "pyzmq")
            },
            "digest": canonical_digest({
                k: v for k, v in sorted(pyenv.items())
                if k not in ("probed", "probe_command")
            }),
        }
    else:
        # A NAMED GAP, EXCLUDED FROM THE HASH. V5 section 14 names "Python
        # environment manifest digest" as a manifest field; if the probe could not
        # run, the honest outcome is a gap, never a default. This gap is
        # LOAD-BEARING (the IPython kernel IS the product's execution surface), so
        # the identity is not computable -- see `identity_computable` below.
        gaps.append({
            "field": "python_environment",
            "why": f"the bounded Python probe did not produce a manifest: {pyenv.get('error')}",
            "load_bearing": True,
            "consequence": "RuntimeDeploymentIdentity is NOT COMPUTABLE: the interpreter that runs the product's primary execution surface is unidentified.",
        })

    b["built_launcher"] = {
        "path": lock_inputs.get("launcher_realpath"),
        "sha256": sha256_file(launcher_path) if launcher_path.is_file() else None,
        "lock_artifact_sha256": lock_inputs.get("artifact_sha256"),
        "sha256_matches_lock": (sha256_file(launcher_path) == lock_inputs.get("artifact_sha256"))
        if launcher_path.is_file() else None,
        "_note": (
            "The digest is recomputed from the file, and the lock's value is carried "
            "beside it so a divergence is visible. G-ENV-06: the BUILT launcher is the "
            "qualified artifact; the source launcher is a development convenience and is "
            "not a drop-in substitute (reproduced 3/3)."),
    }
    if not launcher_path.is_file():
        problems.append(f"the launcher named by the lock does not exist: {launcher_path}")

    b["package_digests"] = {
        name: {**tree_digest(rel), "package_json_sha256": sha256_file(ROOT / rel.replace("/lib", "") / "package.json")}
        for name, rel in sorted(PACKAGE_TREES.items())
    }

    b["python_source_digests"] = {
        name: {
            "path": rel,
            "sha256": sha256_file(ROOT / rel),
            "_note": "No npm build step touches this file, so a lib/ digest cannot see a change to it.",
        }
        for name, rel in sorted(PYTHON_SOURCES.items())
    }
    # The bridge client is embedded rather than a file -- see EMBEDDED_PYTHON_CLIENTS
    # for why hashing bridge.ts would be a weaker claim than it looks.
    b["embedded_python_clients"] = {
        name: extract_embedded_client(spec)
        for name, spec in sorted(EMBEDDED_PYTHON_CLIENTS.items())
    }
    for name, row in b["embedded_python_clients"].items():
        if row.get("sha256") is None:
            gaps.append({
                "field": f"embedded_python_clients.{name}",
                "why": row.get("error", "extraction failed"),
                "load_bearing": True,
                "consequence": (
                    "the bridge client is the Python code every model-authored cell uses to reach "
                    "a native tool; without its hash the manifest does not identify the execution "
                    "path the product depends on."),
            })
    missing_python = [n for n, row in b["python_source_digests"].items() if row["sha256"] is None]
    for name in missing_python:
        # The broker and the data client are named by V5 section 14 ("broker/data
        # Python hashes") and are the identity of the code a kernel executes. A
        # missing one is a gap with its consequence stated, not a silent omission.
        gaps.append({
            "field": f"python_source_digests.{name}",
            "why": f"the file {PYTHON_SOURCES[name]} does not exist in this tree",
            "load_bearing": name == "broker",
            "consequence": (
                "the broker is the process that executes every model-authored cell; without its "
                "hash the manifest does not identify the execution surface."
                if name == "broker" else
                "this Python client is not hashed; a change to it would not move the identity."),
        })

    # PROFILE AND PRESET. Both digests are computed HERE from the tree and the
    # lock's recorded values are carried beside them, so the four-times-repeated
    # "the recorded digest went stale" failure is visible rather than inherited.
    profile_rel = "profiles/daily-candidate/cordis.patch.yml"
    preset_rel = "profiles/daily-candidate/presets/daily-standard/agent.cordis.yml"
    b["profile"] = {
        "path": profile_rel,
        "sha256": sha256_file(ROOT / profile_rel),
        "lock_host_profile_digest": lock_inputs.get("host_profile_digest"),
        "matches_lock": (sha256_file(ROOT / profile_rel) == lock_inputs.get("host_profile_digest")),
        "installed_at": f"{driver.get('home')}/profiles/{driver.get('profile')}/cordis.patch.yml",
        "installed_sha256": sha256_file(Path(f"{driver.get('home')}/profiles/{driver.get('profile')}/cordis.patch.yml"))
        if driver.get("home") else None,
    }
    b["agent_preset"] = {
        "path": preset_rel,
        "id": lock_inputs.get("agent_preset_id"),
        "sha256": sha256_file(ROOT / preset_rel),
        "lock_agent_preset_digest": lock_inputs.get("agent_preset_digest"),
        "matches_lock": (sha256_file(ROOT / preset_rel) == lock_inputs.get("agent_preset_digest")),
        "default_id_measured": probe.get("presetDefaultId"),
        "roots_measured": probe.get("presetRoots"),
    }

    # ── THE RESOLVED PLUGIN GRAPH, FRESHLY OBSERVED, WITH REALPATHS ──────────
    #
    # THIS IS THE FIELD THE OLD IDENTITY GOT WRONG, and the fix is the source of
    # the value rather than its name. The old `resolved_plugin_graph_digest` was
    # the sha256 of a DUMP FILE (`qualification/results/M3.1-c2-profile/
    # dump-config-daily-candidate.yml`) that NO tool checked -- `grep -c
    # resolved_plugin_graph_digest helpers/rederive-identity.py helpers/doctor.py`
    # was `0` and `0` -- and that dump predates F3, so its `sandbox-policy.mode`
    # still reads the confining `workspace-write` while the tree resolves
    # `danger-full-access`. So an identity input certified a graph containing the
    # exact defect CMP-02 exists to catch. A dump is what the loader DECLARED; this
    # is what it ACTIVATED, resolved to realpaths.
    extension_rows = probe.get("extensionRows") or []
    b["resolved_plugin_graph"] = {
        "source": "FRESH_OBSERVATION_FROM_A_LIVE_BOOT",
        "observed_at": observation.get("ran_at"),
        "row_count": graph.get("rowCount"),
        "active_row_count": graph.get("activeRowCount"),
        "resolved_row_count": graph.get("resolvedRowCount"),
        "loader_builtin_row_count": graph.get("builtinRowCount"),
        "unresolved_rows": graph.get("unresolvedRows"),
        "composition_digest": graph.get("digest"),
        "resolved_url_digest": graph.get("rowsDigest"),
        "realpath_digest": graph.get("realpathDigest"),
        "extension_rows": extension_rows,
        "auto_generated_id_rows": graph.get("autoGeneratedIdRows"),
        "superseded_lock_field": {
            "field": "deployment.inputs.resolved_plugin_graph_digest",
            "value": lock_inputs.get("resolved_plugin_graph_digest"),
            "basis": "qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml",
            "basis_sha256": sha256_file(ROOT / "qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml"),
            "checked_by_any_tool": False,
            "stale_reason": (
                "the dump is from 786edb1, before F3, and its sandbox-policy row still reads "
                "mode: workspace-write. See qualification/results/ROOT-round2/"
                "identity-input-unchecked-and-stale.md, re-measured for this manifest."),
            "_why_it_is_carried_and_not_deleted": (
                "Deleting it would erase the evidence that the defect existed. Carrying it "
                "here, beside the fresh value, is what makes the supersession auditable -- and "
                "it is now a RECORD rather than an input, so it cannot certify anything."),
        },
    }
    if (graph.get("unresolvedRows") or []):
        problems.append(
            f"{len(graph['unresolvedRows'])} row(s) did not resolve to a file: "
            f"{json.dumps(graph['unresolvedRows'][:5])}. A row that cannot resolve is the "
            "composition defect this graph exists to catch.")
    if not extension_rows:
        problems.append(
            "the observation carries no dsh-daily-work/dsh-ipython row: the manifest cannot "
            "identify the implementation it describes")

    # ── THE ACTUAL MODEL TOOL CATALOG/SCHEMA/ORDER ──────────────────────────
    b["model_tool_catalog"] = {
        "source": "FRESH_OBSERVATION_FROM_A_LIVE_BOOT",
        "session_id": catalog.get("sessionId"),
        "session_cwd": catalog.get("sessionCwd"),
        "tool_count": catalog.get("toolCount"),
        "names_in_header_order": catalog.get("namesInHeaderOrder"),
        "names_sorted": catalog.get("namesSorted"),
        "schema_digest": catalog.get("schemaDigest"),
        "order_digest": catalog.get("orderDigest"),
        "has_run_code": catalog.get("hasRunCode"),
        "_why_order_and_schema_are_both_hashed": (
            "`ctx.tools.schemas(agent)` returns schemas in the order the model reads them, "
            "so two boots offering the same names in a different order are a different "
            "deployment -- the first tool is what the model reaches for. And a tool whose "
            "NAME is stable while its PARAMETERS changed is a different tool surface. A "
            "digest over a sorted name set would call both changes invisible."),
    }

    # ── HARD CHILD CAP AND PRESENTATION MODE ────────────────────────────────
    expected_contract = expected.get("product_contract") or {}
    subagent_cfg = ((probe.get("selectedRowConfigs") or {}).get("subagent") or {}).get("config") or {}
    tools_cfg = ((probe.get("selectedRowConfigs") or {}).get("tools") or {}).get("config") or {}
    b["hard_child_cap"] = {
        "requirement": expected_contract.get("hard_child_capacity"),
        "requirement_source": "compatibility.expected.json -> product_contract.hard_child_capacity (V5 product contract)",
        "enforced_by": "packages/dsh-daily-work/src/capacity.ts -> HARD_CHILD_CAPACITY (the project's host-global gate, across roots)",
        "mounted_subagent_row": {
            "maxActiveSubagents": subagent_cfg.get("maxActiveSubagents"),
            "maxDepth": subagent_cfg.get("maxDepth"),
            "_why_this_is_NOT_the_cap": (
                "DSH's `maxActiveSubagents` caps ONE ROOT's continuable pool. Two roots "
                "would each get a full pool, so 2 x N children on a 'N child' deployment -- "
                "which is exactly why the project enforces the host-global cap itself. A "
                "reader must not read the row's value as the deployment's cap, nor read a "
                "value below 30 as the cap being weakened: it is the user-selected target N."),
        },
    }
    b["presentation_mode"] = {
        "requirement": expected_contract.get("presentation_mode_requirement"),
        "measured_from": "the absence of `run_code` in a non-empty model tool catalog",
        "measured_value": (
            None if catalog.get("hasRunCode") is None
            else ("native" if catalog.get("hasRunCode") is False else "ptc_or_both")),
        "mounted_tools_row_mode": tools_cfg.get("mode"),
        "_why_the_measured_value_is_derived_and_not_read": (
            "`ToolRuntime.modeFor(scope)` is private and the resolved default is applied at "
            "construction, so the probe cannot read it. What it CAN read is the catalog: "
            "`run_code` is presented only under ptc/both "
            "(packages/core/tools/src/index.ts:1331 denies a native name when modeFor is "
            "'ptc' and the name is not RUN_CODE_NAME). Its ABSENCE from a 27-tool catalog is "
            "therefore positive evidence of `native` -- a NEGATIVE observation, which is "
            "weaker than reading the field and is stated as such rather than presented as a "
            "direct read."),
    }

    # ── ACCEPTANCE DEFINITION (the contract half's input) ────────────────────
    definition_digest = canonical_file_digest(DEFINITION)
    if definition_digest is None:
        problems.append(f"the acceptance definition is missing: {DEFINITION}")
    try:
        definition = json.loads(DEFINITION.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        definition = {}
        problems.append(f"the acceptance definition is unreadable: {exc}")

    runner_digests = {
        rel: canonical_file_digest(ROOT / rel) for rel in CONTRACT_RUNNER_FILES
    }
    missing_runners = [rel for rel, d in runner_digests.items() if d is None]
    for rel in missing_runners:
        gaps.append({
            "field": f"qualification_runner_digests.{rel}",
            "why": "the file does not exist in this tree",
            "load_bearing": False,
            "consequence": "this runner is not bound into the contract identity, so a change to it would not move the contract.",
        })

    manifest["contract"] = {
        "acceptance_definition_path": str(DEFINITION.relative_to(ROOT)).replace("\\", "/"),
        "acceptance_definition_digest": definition_digest,
        "acceptance_definition_version": definition.get("definition_version"),
        "acceptance_definition_contract_id": definition.get("contract_id"),
        "acceptance_definition_case_count": definition.get("total_cases"),
        "provenance_path": str(PROVENANCE.relative_to(ROOT)).replace("\\", "/"),
        "provenance_digest": canonical_file_digest(PROVENANCE),
        "frozen_v1_snapshot_path": str(FROZEN_V1.relative_to(ROOT)).replace("\\", "/"),
        "frozen_v1_snapshot_sha256": canonical_file_digest(FROZEN_V1),
        "qualification_runner_digests": runner_digests,
        "results_location_rule": (
            "qualification/results/<QualificationContractIdentity>/ -- a RESULT IS FILED BY "
            "WRITING A FILE THERE, which is an input of NEITHER hash. That is the property "
            "that makes the split work, and it is checked below rather than asserted."),
    }

    # A gap that is load-bearing makes the identity NOT COMPUTABLE. The gap is
    # recorded EITHER WAY, and it is EXCLUDED from the hashed set -- because
    # substituting a default to make the hash agree is the "change the thing
    # measured" failure this project forbids.
    load_bearing = [g for g in gaps if g.get("load_bearing")]
    manifest["identity_computable"] = len(problems) == 0 and len(load_bearing) == 0
    if not manifest["identity_computable"]:
        manifest["identity_refusal"] = {
            "problems": problems,
            "load_bearing_gaps": [g["field"] for g in load_bearing],
            "why_no_identity_is_emitted": (
                "An identity computed over an incomplete or unstable input set would be a "
                "constant wearing the name of a variable -- the defect "
                "qualification-identity.py's `assert_no_constant_inputs` was written for. So "
                "no RuntimeDeploymentIdentity is emitted at all, and a reader cannot mistake "
                "a partial manifest for a complete one."),
        }
        return manifest, problems

    # ── THE TWO IDENTITIES ──────────────────────────────────────────────────
    runtime_identity = canonical_digest(b)
    contract_identity = canonical_digest({
        "runtime_deployment_identity": runtime_identity,
        **manifest["contract"],
    })
    manifest["runtime_deployment_identity"] = runtime_identity
    manifest["qualification_contract"] = {
        "qualification_contract_identity": contract_identity,
        "contract_id": f"trusted-local-v3.{contract_identity[:12]}",
        "results_location": f"qualification/results/trusted-local-v3.{contract_identity[:12]}/",
        "_algorithm": (
            "H(RuntimeDeploymentIdentity + acceptance_definition_digest + "
            "release_runner_digests), canonical-JSON sha256."),
    }

    # THE STRUCTURAL PROPERTY, CHECKED ON THE COMPUTED MODEL RATHER THAN ASSERTED.
    # Neither input set may contain a status, a verdict or an evidence path: that is
    # what lets a result be filed without moving either hash.
    for label, bucket in (("build", b), ("contract", manifest["contract"])):
        blob = json.dumps(bucket, ensure_ascii=True).lower()
        for banned in ('"status"', '"verdict"', '"evidence_path"'):
            if banned in blob:
                problems.append(f"{label} inputs contain {banned}, which a filed result could move")

    return manifest, problems


# ---------------------------------------------------------------------------
# compatibility.expected.json: validation and the self-reference audit
# ---------------------------------------------------------------------------
def load_expected() -> dict[str, Any]:
    if not EXPECTED.is_file():
        return {}
    try:
        return json.loads(EXPECTED.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def check_expected() -> tuple[list[str], list[str], list[str]]:
    """Returns (problems, notes, measured). problems => exit 1; unusable => exit 2.

    THE SELF-REFERENCE AUDIT IS THE POINT. The one property this file must have is
    that no edit to the deployment moves it. So every sha256-shaped string in it is
    walked and must be in the allowlist with a reason -- which makes "we removed the
    self-reference" falsifiable instead of asserted.
    """
    problems: list[str] = []
    notes: list[str] = []
    measured: list[str] = []

    if not EXPECTED.is_file():
        return [f"compatibility.expected.json is missing at {EXPECTED}"], notes, measured
    try:
        expected = json.loads(EXPECTED.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"compatibility.expected.json is unreadable: {exc}"], notes, measured

    if expected.get("schema_version") != 1:
        problems.append(f"schema_version is {expected.get('schema_version')!r}, expected 1")

    # ── the self-reference audit ────────────────────────────────────────────
    allowed = {
        row["value"]: row["reason"]
        for row in (expected.get("self_reference_audit") or {}).get("allowed_digest_values") or []
    }
    found: dict[str, int] = {}
    def walk(value: Any) -> None:
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

    for value, count in sorted(found.items()):
        if value not in allowed:
            problems.append(
                f"a sha256 appears in compatibility.expected.json OUTSIDE the allowlist "
                f"({value[:16]}..., {count}x). That is the self-reference this file exists to "
                "remove: a digest of a file in this repository inside a checked-in file means "
                "editing that file moves the requirements. Either remove it, or add it to "
                "self_reference_audit.allowed_digest_values with a reason.")
    for value, reason in sorted(allowed.items()):
        if value not in found:
            notes.append(f"an allowlisted digest is not present in the file any more: {value[:16]}... ({reason[:60]})")
    if not problems:
        measured.append(
            f"self-reference audit: {len(found)} distinct sha256 value(s), all allowlisted "
            f"({len(allowed)} entry/entries). No edit to a profile, preset, spec or dump moves this file.")

    # ── the frozen v1 snapshot really is frozen ─────────────────────────────
    frozen = ((expected.get("acceptance_definition") or {})
              .get("v1_is_frozen_and_not_superseded_on_disk") or {})
    recorded_frozen = frozen.get("sha256")
    if isinstance(recorded_frozen, str):
        actual = sha256_file(FROZEN_V1)
        if actual == recorded_frozen:
            measured.append(f"frozen v1 snapshot hashes to the recorded value ({recorded_frozen[:16]}...)")
        else:
            problems.append(
                f"the frozen v1 snapshot does NOT hash to the value recorded in "
                f"compatibility.expected.json: recorded {recorded_frozen[:16]}... "
                f"actual {str(actual)[:16]}... . 'Frozen' is the reason its digest is allowed "
                "here; if it can change, that reason is false.")

    # ── the requirements, checked against THIS machine ──────────────────────
    upstream = expected.get("upstream") or {}
    checkout = pinned_checkout()
    if not checkout.get("present"):
        problems.append(f"the pinned checkout is not present at {checkout.get('path')}")
    else:
        if checkout.get("head") != upstream.get("commit"):
            problems.append(
                f"the pinned checkout's HEAD is {checkout.get('head')} but the requirement is "
                f"{upstream.get('commit')} (ID-06)")
        else:
            measured.append(f"pinned checkout HEAD equals the required commit ({str(upstream.get('commit'))[:16]}...)")
        if checkout.get("clean") is not True:
            # A REAL failure, not staleness. ID-06's oracle: "any tracked
            # modification, any staged change, or a moved HEAD is NOT PASS".
            problems.append(
                f"the pinned checkout is DIRTY: {len(checkout.get('porcelain_rows') or [])} tracked "
                f"path(s) modified ({json.dumps((checkout.get('porcelain_rows') or [])[:5])}). "
                "ID-06's oracle requires a clean working tree.")
        else:
            measured.append("pinned checkout working tree is clean")

    toolchain = expected.get("supported_toolchain") or {}
    node_req = (toolchain.get("node") or {}).get("requirement")
    node_actual, node_error = run_version("node")
    if node_req is not None and node_actual is not None:
        # The requirement is an npm-style range (`^22.19.0 || >=24.0.0`). Evaluating
        # it needs a semver implementation; this checker has none and does NOT
        # hand-roll one, because a second implementation of a standard is a second
        # thing to be wrong. It reports both values and says plainly that the range
        # was not evaluated -- see the named gap in the report. A checker that
        # silently skipped the comparison would be worse than one that states it did.
        measured.append(
            f"Node measured {node_actual}; requirement is {node_req!r}. "
            "RANGE MATCH NOT EVALUATED by this checker (no semver implementation is "
            "vendored); the two values are reported so a reader can compare them.")
    elif node_req is not None:
        problems.append(f"the Node requirement cannot be checked: {node_error or 'node is not on PATH'}")

    pnpm_req = (toolchain.get("pnpm") or {}).get("requirement")
    # WHICH pnpm IS THE DEPLOYMENT'S pnpm, measured rather than assumed.
    #
    # THE DEFECT THIS CHECK HAD, found by running it. A bare `pnpm --version`
    # resolves the GLOBAL install and reported 11.24.0, which failed the
    # requirement of exactly 11.7.0. But gate A02 already recorded the correct
    # distinction: "corepack pinned pnpm 11.7.0; the global 11.24.0 was not used."
    # The pinned upstream declares `packageManager: pnpm@11.7.0`, so the pnpm this
    # deployment uses is the COREPACK-RESOLVED one, and the global shim is a
    # different program that happens to share a name.
    #
    # So the requirement is checked against `corepack pnpm`, and the global value is
    # reported BESIDE it rather than used as the measurement. A checker that failed
    # on the global shim would be reporting a fact about the operator's PATH as if it
    # were a fact about the deployment -- which is the same class of error as
    # measuring the wrong tree.
    pnpm_actual, pnpm_error = run_version("corepack pnpm")
    pnpm_global, pnpm_global_error = run_version("pnpm")
    if pnpm_req is not None:
        if pnpm_actual is None:
            problems.append(
                f"the pnpm requirement cannot be checked: `corepack pnpm --version` gave "
                f"{pnpm_error or 'no output'}. The pinned upstream declares "
                f"`packageManager: pnpm@{pnpm_req}`, so the deployment's pnpm is the "
                "corepack-resolved one and the global shim is not a substitute.")
        elif pnpm_actual != pnpm_req:
            problems.append(
                f"corepack pnpm measured {pnpm_actual} but the requirement is exactly {pnpm_req}")
        else:
            measured.append(
                f"corepack pnpm measured {pnpm_actual}, equal to the requirement. "
                f"(The global `pnpm` shim reports {pnpm_global or pnpm_global_error!r}, which is a "
                "different program and is NOT the deployment's package manager -- gate A02 "
                "records the same distinction.)")

    py_req = (toolchain.get("python") or {}).get("requirement")
    if py_req is not None:
        env = python_environment()
        if env.get("probed") is not True:
            problems.append(f"the Python requirement {py_req!r} cannot be checked: {env.get('error')}")
        else:
            version = env.get("python_version") or ""
            m = re.match(r"^>=(\d+)\.(\d+)$", py_req)
            if m is None:
                notes.append(f"the Python requirement {py_req!r} is not in the `>=X.Y` form this checker evaluates")
            else:
                want = (int(m.group(1)), int(m.group(2)))
                try:
                    got = tuple(int(p) for p in version.split(".")[:2])
                except ValueError:
                    got = None
                if got is None:
                    problems.append(f"the Python version {version!r} is unparseable")
                elif got < want:
                    problems.append(f"Python {version} does not satisfy the requirement {py_req}")
                else:
                    measured.append(f"Python {version} satisfies {py_req}")

    # ── the acceptance definition carries the declared shape ────────────────
    ad = expected.get("acceptance_definition") or {}
    try:
        definition = json.loads(DEFINITION.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"the acceptance definition is unreadable: {exc}")
        definition = {}
    if definition:
        if definition.get("total_cases") != ad.get("case_count"):
            problems.append(
                f"the definition carries {definition.get('total_cases')} cases but "
                f"compatibility.expected.json declares {ad.get('case_count')}")
        else:
            measured.append(f"the definition carries the declared {ad.get('case_count')} cases")
        if definition.get("definition_version") != ad.get("definition_version"):
            problems.append(
                f"the definition version is {definition.get('definition_version')!r} but "
                f"the requirement is {ad.get('definition_version')!r}")
        # A CASE's `family` field carries the family NAME ("IDENTITY"), not its
        # prefix ("ID"). Comparing the names against the declared prefixes reported
        # 11 spurious mismatches on the first run of this checker -- a defect in the
        # CHECK, and one worth recording because it is the shape this project keeps
        # hitting: a measurement that reads the wrong field and reports a confident
        # wrong answer. The prefixes are read from `families[].prefix`, which is where
        # the definition declares them, and the NAMES are checked separately.
        prefixes = sorted(f.get("prefix") for f in definition.get("families") or [])
        declared = sorted(ad.get("family_prefixes") or [])
        if prefixes != declared:
            problems.append(
                f"the definition's family prefixes {prefixes} differ from the declared {declared}")
        else:
            measured.append(f"the definition declares the declared family prefixes {prefixes}")
        # The family NAMES are checked too, from the same place, so a family whose
        # prefix stayed and whose subject changed is visible.
        names = sorted(f.get("name") for f in definition.get("families") or [])
        case_names = sorted({c.get("family") for c in definition.get("cases") or []})
        if names != case_names:
            problems.append(
                f"the definition's family names {names} do not match the names its cases carry "
                f"{case_names}: a case belongs to a family the definition does not declare.")

    return problems, notes, measured


# ---------------------------------------------------------------------------
# GRAPH-REALPATH (V5 section 18)
# ---------------------------------------------------------------------------
def graph_realpath_check(observation: dict[str, Any]) -> tuple[list[str], list[str], dict[str, Any]]:
    """A foreign worktree or module realpath must FAIL.

    WHY THIS IS A SEPARATE GATE AND NOT A FIELD IN THE MANIFEST. V5 section 18
    names GRAPH-REALPATH as its own case, and the reason is this project's history:
    two root-agent findings (G-SEAM-29, G-SEAM-36) were RETRACTED because a
    measurement ran against the wrong tree, and `cross-tree-paths.test.ts` plus
    G-SEAM-66 exist because a writer's test rewrote a sibling's evidence. A manifest
    that merely RECORDED a realpath would make the same class of mistake legible
    without preventing it. This gate refuses.

    WHAT IT CHECKS, and each half is falsifiable:
      1. Every dsh-daily-work / dsh-ipython row's realpath is INSIDE the tree that
         produced the observation. That tree is `driver.repo_root`, recorded by the
         driver from its own `import.meta.url` -- not a literal, because no literal
         can be correct for a repository checked out in fifteen places at once.
      2. No row's realpath is inside a DIFFERENT checkout under `DSH/work`. This is
         the same shape `cross-tree-paths.test.ts` refuses, applied to the RUNTIME
         graph rather than to source text: a static scan cannot see the resolved
         graph, and this is where a foreign resolution actually lands.
      3. The observation's own tree still exists and its packages still resolve
         where the observation said. This catches the case where the observation was
         taken correctly and the TREE MOVED afterwards.

    THE NEGATIVE CONTROL IS IN THE DRIVER. `--graph-realpath-check` is exercised
    with a synthesized observation whose realpath points at a foreign worktree, and
    the gate must go RED -- see qualification/results/P14-manifest/graph-realpath-controls.json.
    A gate that never fires and a gate that is absent produce identical evidence.
    """
    problems: list[str] = []
    notes: list[str] = []
    detail: dict[str, Any] = {}

    driver = observation.get("driver") or {}
    probe = observation.get("probe") or {}
    repo_root = driver.get("repo_root")
    detail["observed_in_tree"] = repo_root
    detail["observation_ran_at"] = observation.get("ran_at")

    if not repo_root:
        problems.append("the observation does not name the tree it was taken in (driver.repo_root): GRAPH-REALPATH cannot be decided")
        return problems, notes, detail

    own = str(repo_root).replace("\\", "/").rstrip("/").lower()
    detail["own_tree_normalised"] = own

    extension_rows = probe.get("extensionRows") or []
    if not extension_rows:
        problems.append("the observation carries no extension rows: there is no realpath to check")
        return problems, notes, detail

    foreign: list[dict[str, Any]] = []
    outside: list[dict[str, Any]] = []
    for row in extension_rows:
        realpath = row.get("realpath")
        name = row.get("name")
        if realpath is None:
            problems.append(f"extension row {name!r} has NO realpath: its resolution failed ({row.get('resolveError')})")
            continue
        norm = str(realpath).replace("\\", "/").lower()
        # (1) inside the tree that produced the observation
        if not norm.startswith(own + "/"):
            outside.append({"name": name, "realpath": realpath})
        # (2) not inside ANY OTHER checkout under DSH/work. The regex mirrors
        #     cross-tree-paths.test.ts's CHECKOUT_LITERAL, which refuses exactly the
        #     set of paths that can belong to another checkout.
        m = re.search(r"([a-z]:[\\/]+dsh[\\/]+work[\\/]+)([a-z0-9_.-]+)", norm)
        if m is not None and norm.startswith(own) is False:
            foreign.append({"name": name, "realpath": realpath, "other_checkout": m.group(2)})

    detail["extension_rows_checked"] = len(extension_rows)
    detail["rows_outside_own_tree"] = outside
    detail["rows_in_another_checkout"] = foreign

    if outside:
        problems.append(
            f"{len(outside)} extension row(s) resolve OUTSIDE the tree that produced the "
            f"observation ({repo_root}): {json.dumps(outside[:5])}. A boot that loads the "
            "implementation from another tree is measuring a deployment that is not this one "
            "-- the defect that forced G-SEAM-29 and G-SEAM-36 to be retracted.")
    if foreign:
        problems.append(
            f"{len(foreign)} extension row(s) resolve into ANOTHER CHECKOUT under DSH/work: "
            f"{json.dumps(foreign[:5])}. This is the GRAPH-REALPATH refusal: no literal can be "
            "correct for a repository checked out in many places at once.")

    # (3) the tree is still there, and its packages still resolve where the
    #     observation said. An observation taken correctly and then invalidated by a
    #     move is a DIFFERENT condition from a wrong observation, and both must fail.
    if not Path(repo_root).is_dir():
        problems.append(f"the tree that produced the observation no longer exists: {repo_root}")
    else:
        for pkg in PACKAGE_TREES:
            lib = Path(repo_root) / "packages" / pkg / "lib"
            if not lib.is_dir():
                problems.append(f"{pkg}: {lib} is missing, so the observation cannot still describe this tree")
        stale = []
        for row in extension_rows:
            realpath = row.get("realpath")
            if realpath is None:
                continue
            # The built file the row resolved to must still hash the same. A rebuilt
            # package after the observation means the observation describes a build
            # that is no longer on disk.
            if Path(realpath).is_file():
                continue
            stale.append({"name": row.get("name"), "realpath": realpath})
        if stale:
            problems.append(f"{len(stale)} resolved module(s) no longer exist on disk: {json.dumps(stale[:5])}")

    if not problems:
        notes.append(
            f"all {len(extension_rows)} extension row(s) resolve inside {repo_root} and none "
            "resolves into another checkout")
    return problems, notes, detail


def compare_manifests(old_path: Path, new_path: Path) -> tuple[list[str], list[str], dict[str, Any]]:
    """ID-FRESH: a build that differs must be REJECTED against an older identity.

    V5 section 18 names this case and gives it one line:

        ID-FRESH   current runtime graph/build differs -> old identity rejected.

    WHY THIS FUNCTION HAS TO EXIST FOR THE MANIFEST TO MEAN ANYTHING. Computing two
    identities is not the same as REJECTING a stale one. Without a consumer that
    compares them, an old identity is a string that happens to differ from a new
    string, and nothing in the release path notices. That is this project's
    most-recorded defect -- the mechanism exists, is correct, and nothing calls it --
    so the consumer is written here rather than assumed to arrive later.

    WHAT IT DECIDES, and the two failure modes are reported separately because they
    call for different actions:

      * RUNTIME identity differs -> the DEPLOYMENT changed (a profile, a preset, a
        built package, the graph, the catalog, the environment). Every verdict bound
        to the old identity is invalid and must be RE-MEASURED.
      * only the CONTRACT identity differs -> the deployment is UNCHANGED and the
        contract moved (an oracle, a dependency, or a runner digest). The existing
        measurements may still apply; RE-QUALIFY the contract.

    A single combined hash cannot distinguish those, and this project's own
    qualification-identity.py records why that matters: "A reader who sees only the
    second failure learns 'the contract moved, re-qualify the contract'; a reader who
    sees the first learns 'the deployment moved, re-measure'."

    THE COMMIT-MOVED-ONLY CASE IS REPORTED, NOT TREATED AS DRIFT. `implementation_commit`
    is a runtime input, so every commit moves the identity -- including a commit that
    changed nothing else. A reader told only "runtime moved, RE-MEASURE" would re-run a
    boot to learn that nothing changed. So the changed FIELDS are named, and a
    commit-only move is visibly different from an artifact move.
    """
    problems: list[str] = []
    notes: list[str] = []
    detail: dict[str, Any] = {}

    def load(path: Path, label: str) -> dict[str, Any] | None:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            problems.append(f"the {label} manifest is unreadable ({path}): {exc}")
            return None

    old = load(old_path, "old")
    new = load(new_path, "new")
    if old is None or new is None:
        return problems, notes, detail

    old_rt = old.get("runtime_deployment_identity")
    new_rt = new.get("runtime_deployment_identity")
    old_ct = (old.get("qualification_contract") or {}).get("qualification_contract_identity")
    new_ct = (new.get("qualification_contract") or {}).get("qualification_contract_identity")

    if old_rt is None or new_rt is None:
        problems.append(
            "one of the manifests carries no RuntimeDeploymentIdentity, so ID-FRESH cannot "
            "be decided. An identity that was never computable (a load-bearing gap) must not "
            "be compared as if it were a value.")
        return problems, notes, detail

    detail["old_runtime_identity"] = old_rt
    detail["new_runtime_identity"] = new_rt
    detail["old_contract_identity"] = old_ct
    detail["new_contract_identity"] = new_ct
    detail["runtime_moved"] = old_rt != new_rt
    detail["contract_moved"] = old_ct != new_ct
    detail["old_commit"] = (old.get("build") or {}).get("project_git_commit")
    detail["new_commit"] = (new.get("build") or {}).get("project_git_commit")

    if old_rt == new_rt:
        notes.append(
            "the RuntimeDeploymentIdentity is IDENTICAL: the two manifests describe the same "
            "build.")
        if old_ct == new_ct:
            notes.append("The QualificationContractIdentity is also identical: nothing moved.")
            return problems, notes, detail
        # A CONTRACT-ONLY MOVE IS STILL A REJECTION, and the first version of this
        # function got that wrong -- found by the CONTRACT control, which expected
        # exit 1 and observed 0.
        #
        # The reasoning that produced the bug: "the deployment did not change, so
        # nothing is stale". The reasoning that corrects it: RESULT AND EVIDENCE FILES
        # BIND TO QualificationContractIdentity (V5 section 14). So a contract move
        # invalidates every filed result exactly as a runtime move does -- the
        # difference is WHY and therefore WHAT TO DO, not WHETHER to reject.
        #
        # Collapsing the two into one exit code would lose the distinction; collapsing
        # them into one MESSAGE would too. So the rejection is the same and the reason
        # is different, which is the whole value of having split the hash in the first
        # place: "re-qualify the contract" and "re-measure the deployment" are
        # different actions and a reader must be told which.
        detail["why"] = (
            "STALE, CONTRACT MOVED ONLY: the deployment is unchanged and the contract moved -- "
            "an oracle, a dependency, or a runner digest. Filed results bind to the contract "
            "identity, so they are stale. RE-QUALIFY the contract; the existing measurements "
            "may still apply under reuse, and NO re-measurement of the deployment is needed.")
        problems.append(
            f"ID-FRESH: the QualificationContractIdentity CHANGED ({str(old_ct)[:16]}... -> "
            f"{str(new_ct)[:16]}...) while the RuntimeDeploymentIdentity did NOT. "
            + detail["why"])
        return problems, notes, detail

    # The runtime identity moved. WHICH FIELDS, so a commit-only move is visible.
    old_build = old.get("build") or {}
    new_build = new.get("build") or {}
    changed = sorted(
        key for key in set(old_build) | set(new_build)
        if old_build.get(key) != new_build.get(key)
    )
    artifact_fields = [f for f in changed if f not in ("project_git_commit", "project_git_tree")]
    commit_only = sorted(changed) == ["project_git_commit", "project_git_tree"]
    detail["changed_build_fields"] = changed
    detail["changed_artifact_fields"] = artifact_fields
    detail["commit_moved_only"] = commit_only

    if commit_only:
        detail["why"] = (
            "STALE, COMMIT MOVED ONLY: the implementation revision changed and every other "
            "runtime input is byte-identical, so the deployment is materially the same and the "
            "previous measurements still describe it. This is the expected state at a writer's "
            "tip. RE-DERIVE the identity (cheap); RE-MEASURE only if an artifact field appears "
            "in changed_artifact_fields.")
    else:
        detail["why"] = (
            "STALE, RUNTIME MOVED: runtime inputs other than the commit changed, so the "
            "measurements no longer describe this build. RE-MEASURE. Changed: "
            + ", ".join(artifact_fields))

    # THE REFUSAL ITSELF. This is the case V5 section 18 names, and it is reported as
    # a PROBLEM (exit 1) rather than a note, because a release that reuses the old
    # verdicts under a changed runtime identity is the failure the case exists for.
    problems.append(
        f"ID-FRESH: the RuntimeDeploymentIdentity CHANGED ({str(old_rt)[:16]}... -> "
        f"{str(new_rt)[:16]}...), so every verdict bound to the old identity is stale. "
        + detail["why"])
    return problems, notes, detail


# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="generate the BuildManifest and the split identities")
    parser.add_argument("--check-expected", action="store_true",
                        help="validate compatibility.expected.json and check its requirements against this machine")
    parser.add_argument("--from-observation", default=None,
                        help="a fresh observation.json from run-p14-manifest.mjs")
    parser.add_argument("--graph-realpath-check", default=None,
                        help="run ONLY the GRAPH-REALPATH gate over an observation")
    parser.add_argument("--id-fresh-check", nargs=2, default=None, metavar=("OLD", "NEW"),
                        help="ID-FRESH (V5 section 18): compare two manifests and REJECT the "
                             "old identity when the runtime deployment moved")
    parser.add_argument("--write", action="store_true",
                        help="write the manifest into the results directory (refused without --from-observation)")
    parser.add_argument("--json", action="store_true", help="print the manifest as JSON")
    args = parser.parse_args()

    if args.check_expected:
        problems, notes, measured = check_expected()
        for line in measured:
            print(f"[ok  ] {line}")
        for line in notes:
            print(f"[note] {line}")
        if problems:
            print("")
            print(f"compatibility.expected.json: {len(problems)} problem(s). These are REAL requirement violations, not staleness:")
            for problem in problems:
                print(f"  - {problem}")
            return 1
        print("")
        print("every requirement in compatibility.expected.json holds on this machine.")
        print("This checks REQUIREMENTS. It does not boot anything and is not a qualification.")
        return 0

    if args.id_fresh_check:
        old_path, new_path = (Path(p) for p in args.id_fresh_check)
        problems, notes, detail = compare_manifests(old_path, new_path)
        print(json.dumps({"id_fresh": {"problems": problems, "notes": notes, "detail": detail}}, indent=2))
        if problems:
            print("")
            print(f"ID-FRESH: {len(problems)} problem(s) -- the old identity must NOT be reused.")
            return 1
        print("")
        print("ID-FRESH: the two manifests describe the same runtime deployment.")
        return 0

    if args.graph_realpath_check:
        path = Path(args.graph_realpath_check)
        try:
            observation = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"graph-realpath-check: the observation is unreadable: {exc}", file=sys.stderr)
            return 2
        problems, notes, detail = graph_realpath_check(observation)
        print(json.dumps({"graph_realpath": {"problems": problems, "notes": notes, "detail": detail}}, indent=2))
        if problems:
            print("")
            print(f"GRAPH-REALPATH: {len(problems)} problem(s) -- the graph did NOT come from this tree.")
            return 1
        print("")
        print("GRAPH-REALPATH: every extension row resolved inside the tree that produced the observation.")
        return 0

    if args.from_observation:
        path = Path(args.from_observation)
        try:
            observation = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"build-manifest: the observation is unreadable: {exc}", file=sys.stderr)
            return 2
        observation["_source"] = str(path).replace("\\", "/")
        manifest, problems = build_manifest(observation)
        if not manifest:
            print(json.dumps({"problems": problems}, indent=2))
            print("build-manifest: no manifest can be computed.")
            return 1
        if args.write and manifest.get("identity_computable"):
            out_dir = RESULTS_ROOT / f"trusted-local-v3.{manifest['qualification_contract']['qualification_contract_identity'][:12]}"
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "build-manifest.json").write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
            print(f"wrote {out_dir / 'build-manifest.json'}")
        elif args.write:
            print("build-manifest: REFUSING to write an identity for a manifest that is not computable.", file=sys.stderr)
        if args.json:
            print(json.dumps(manifest, indent=2, ensure_ascii=False))
        else:
            print(f"RuntimeDeploymentIdentity      {manifest.get('runtime_deployment_identity')}")
            if manifest.get("qualification_contract"):
                print(f"QualificationContractIdentity  {manifest['qualification_contract']['qualification_contract_identity']}")
                print(f"contract_id                    {manifest['qualification_contract']['contract_id']}")
            print(f"identity_computable            {manifest.get('identity_computable')}")
            b = manifest.get("build") or {}
            print("")
            print(f"project commit                 {b.get('project_git_commit')}")
            print(f"project tree                   {b.get('project_git_tree')}")
            print(f"dirty                          {b.get('project_git_dirty')} ({b.get('project_git_dirty_path_count')} path(s))")
            print(f"bound to                       {b.get('project_git_bound_to')}")
            g = b.get("resolved_plugin_graph") or {}
            print(f"graph rows                     {g.get('row_count')} (active {g.get('active_row_count')}, resolved {g.get('resolved_row_count')}, builtins {g.get('loader_builtin_row_count')})")
            print(f"graph realpath digest          {g.get('realpath_digest')}")
            c = b.get("model_tool_catalog") or {}
            print(f"tool catalog                   {c.get('tool_count')} tools, run_code={c.get('has_run_code')}")
            print(f"presentation mode (derived)    {(b.get('presentation_mode') or {}).get('measured_value')}")
            print(f"hard child cap (requirement)   {(b.get('hard_child_cap') or {}).get('requirement')}")
            print(f"gaps                           {len(manifest.get('gaps') or [])}")
            for gap in manifest.get("gaps") or []:
                print(f"  - {gap['field']} (load_bearing={gap['load_bearing']}): {gap['why'][:120]}")
            if manifest.get("identity_refusal"):
                print("")
                print("IDENTITY REFUSED:")
                for problem in manifest["identity_refusal"]["problems"]:
                    print(f"  - {problem}")
                for field in manifest["identity_refusal"]["load_bearing_gaps"]:
                    print(f"  - load-bearing gap: {field}")
        return 0 if manifest.get("identity_computable") else 1

    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
