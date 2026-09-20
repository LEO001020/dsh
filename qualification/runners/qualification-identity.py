#!/usr/bin/env python3
"""The trusted-local-v2 identity model: runtime identity, then qualification contract.

THE DEFECT THIS FILE EXISTS TO REMOVE, STATED EXACTLY.

In v1 there was ONE identity, and the acceptance spec served as BOTH an identity
input AND the evidence ledger. So filing a verdict changed the digest of a pinned
identity input. That is not a nuisance; it is a contradiction in the design:

  * `deployment.inputs.trusted_local_acceptance_spec_sha256` pins the spec.
  * The same spec file is where every case's `status` and `evidence` are recorded.
  * Therefore FILING EVIDENCE MOVES A PINNED IDENTITY INPUT.

Measured on this tree: the live ledger's digest moved across **11 distinct
revisions** as families filed. The v1 workaround was a second, frozen snapshot of
the spec as authored -- which works, but it is a patch over the conflation: the
pin no longer names the ledger, so nothing checks that the ledger and the pin
describe the same cases.

THE FIX IS A SPLIT INTO TWO IDENTITIES.

    RuntimeDeploymentIdentity     = H(what is deployed)
    QualificationContractIdentity = H(RuntimeDeploymentIdentity,
                                      acceptance-definition digest,
                                      qualification-runner/gate digests)

Verdicts and evidence are OUTPUTS bound to the contract identity. They appear in
neither hash's input set, so filing a result cannot move either one. A RESULT IS
FILED BY WRITING A FILE UNDER qualification/results/<contract-id>/, and that write
touches no input of any hash.

WHAT "RUNTIME" MEANS HERE, AND WHY THE SPLIT IS NOT COSMETIC.
The two identities fail for DIFFERENT REASONS, and the difference is the whole
value:

  * Perturbing a RUNTIME input (a profile, a preset, a built launcher, a lockfile,
    the resolved graph, the tool catalog) moves RuntimeDeploymentIdentity and
    therefore moves QualificationContractIdentity too. Every verdict is invalidated,
    because the thing measured is no longer the thing on disk.
  * Perturbing the DEFINITION (an oracle, a family, a case's dependencies) moves
    QualificationContractIdentity but leaves RuntimeDeploymentIdentity EXACTLY where
    it was. The deployment is unchanged; only the contract changed.

A reader who sees only the second failure learns "the contract moved, re-qualify the
contract"; a reader who sees the first learns "the deployment moved, re-measure".
A single combined hash cannot distinguish them, and that is precisely why the
combined v1 identity kept producing confusing stale-pin reports.

FIELD PROVENANCE: WHAT IS REUSED AND WHAT IS NEW.
V3 E2 requires reuse of `compatibility.lock.json -> deployment.inputs` rather than
inventing parallel fields, because most of the first hash already exists there. The
mapping is explicit in RUNTIME_INPUT_SOURCES below, one row per V3-named term, so a
reader can see which V3 terms were ALREADY covered and which needed a new input.
`resolved_plugin_graph_digest` and `artifact_sha256` are reused verbatim as
identity inputs, and their values are re-checked against disk rather than trusted.

Usage:
    python qualification/runners/qualification-identity.py                     # report
    python qualification/runners/qualification-identity.py --json              # machine-readable
    python qualification/runners/qualification-identity.py --write              # write identity.json
    python qualification/runners/qualification-identity.py --probe <probe.json> # bind measured inputs
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "compatibility.lock.json"
DEFINITION = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.definition.json"
PROVENANCE = ROOT / "qualification" / "specs" / "acceptance-spec.trusted-local-v2.provenance.json"
RESULTS_ROOT = ROOT / "qualification" / "results"

# The gate/runner artifacts whose digests bind the contract. V3 E2 names
# "qualification-runner/gate digests". These are the files that decide verdicts, so
# a change to one of them changes what a PASS means and must move the contract.
CONTRACT_RUNNER_FILES = [
    "qualification/runners/qualification-identity.py",
    "qualification/runners/verify-spec.py",
    "qualification/runners/build-v2-definition.py",
    "qualification/runners/v2-identity-probe.mjs",
    "qualification/specs/frozen/verify-freeze.py",
    # NOT a runner, and included because leaving it out is a measured omission.
    # `.gitattributes` decides whether a checkout rewrites the bytes of every
    # evidence file, and the evidence hashes ARE contract inputs. Changing it
    # silently changes what every recorded hash means -- measured this round: three
    # v1 evidence entries do not reproduce in a fresh checkout because of it.
    ".gitattributes",
]

# V3 E2's named terms -> the field that supplies them. `source` is one of:
#   lock    -- reused from compatibility.lock.json deployment.inputs, unchanged
#   derived -- computed from a file or the live machine, because the lock has no
#              field for it (a NEW input; each is named as new in the report)
#   probe   -- measured from a live boot, because a declared value cannot answer it
RUNTIME_INPUT_SOURCES: list[dict[str, str]] = [
    {"v3_term": "exact upstream DSH SHA",
     "field": "upstream_commit", "source": "lock",
     "lock_key": "upstream_commit"},
    {"v3_term": "exact implementation SHA",
     "field": "implementation_commit", "source": "derived",
     "why_new": "v1's lock has no field for the implementation's own git revision. "
                "The launcher digest and the profile digests cover the ARTIFACTS, but "
                "the revision that produced them is not an input anywhere, so two "
                "different revisions with identical artifacts would share an identity."},
    {"v3_term": "built launcher digest",
     "field": "artifact_sha256", "source": "lock",
     "lock_key": "artifact_sha256",
     "also": "launcher_realpath is reused as the path the digest covers"},
    {"v3_term": "lockfile digest",
     "field": "dependency_lock_sha256", "source": "lock",
     "lock_key": "dependency_lock_sha256"},
    {"v3_term": "Node identity",
     "field": "node_version", "source": "lock", "lock_key": "node_version"},
    {"v3_term": "pnpm identity",
     "field": "package_manager_version", "source": "lock",
     "lock_key": "package_manager_version"},
    {"v3_term": "Python identity",
     "field": "python_identity", "source": "derived",
     "why_new": "the lock names no Python. It is a real runtime input: the IPython "
                "kernel is a Python process, so its interpreter version and executable "
                "path decide what the primary execution surface IS."},
    {"v3_term": "Jupyter identity",
     "field": "jupyter_identity", "source": "derived",
     "why_new": "the lock names no Jupyter. ipykernel/jupyter_client/jupyter_core "
                "versions decide the kernel protocol and therefore the observable "
                "semantics of every IPY case."},
    {"v3_term": "host profile digest",
     "field": "host_profile_digest", "source": "lock", "lock_key": "host_profile_digest"},
    {"v3_term": "Agent Preset digest",
     "field": "agent_preset_digest", "source": "lock", "lock_key": "agent_preset_digest"},
    {"v3_term": "resolved host graph digest",
     "field": "resolved_plugin_graph_digest", "source": "lock",
     "lock_key": "resolved_plugin_graph_digest",
     "caveat": "REUSED VERBATIM. This value is the sha256 of the DUMP FILE at "
               "qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml, "
               "which is what the loader DECLARED. The probe additionally measures the "
               "RESOLVED host row table (id + module + activation state) from a live "
               "boot; that measured digest is carried as `resolved_host_graph_measured` "
               "and is a SEPARATE input, not a replacement, because the declared dump "
               "and the activated graph are different facts."},
    {"v3_term": "resolved per-Agent tool catalog/schema/order digest",
     "field": "agent_tool_catalog_digest", "source": "probe",
     "why_new": "no lock field covers it, and no file can: the catalog exists only "
                "after the preset resolves for a real Session. The digest covers the "
                "names IN HEADER ORDER plus each tool's canonical parameters, so a "
                "reordering and a parameter change are both visible."},
    {"v3_term": "local extension package digests",
     "field": "extension_package_digests", "source": "derived",
     "why_new": "the two in-repo extension packages are the implementation, but no "
                "lock input names them. Their built `lib/` trees are what the profile "
                "actually loads, so a rebuilt-but-uncommitted lib/ would otherwise be "
                "invisible to the identity."},
    {"v3_term": "provider/model route",
     "field": "model_and_provider_capabilities_digest", "source": "lock",
     "lock_key": "model_and_provider_capabilities_digest"},
    {"v3_term": "trust-model statement",
     "field": "trust_model_statement", "source": "lock",
     "lock_key": "trust_model_statement",
     "also": "isolation_image_or_policy_digest is reused as the policy half"},
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_file_digest(path: Path) -> str:
    """A digest of a file's content that is INVARIANT to checkout line endings.

    WHY THIS IS NOT `sha256_file`, AND WHY IT IS LOAD-BEARING RATHER THAN TIDY.

    Measured on this repository, not anticipated. `.gitattributes` declares
    `*.json text eol=lf` while `core.autocrlf` is `true`. A JSON file written on
    Windows therefore has CRLF endings ON DISK and LF endings IN GIT. So a digest
    taken over the on-disk bytes is a digest of a line-ending convention, and it does
    NOT reproduce from a fresh checkout.

    This was found in v1's own evidence before it was found here: three v1 evidence
    entries record CRLF digests that no fresh checkout reproduces (see
    `qualification/results/trusted-local-v2-identity/evidence-reuse.json` ->
    `line_ending_audit`). It then appeared in THIS slice's definition file: the
    generated definition had 1244 CRLF pairs on disk, so its digest was
    `06a41c99...` while the LF form was `115aa092...`, and the contract identity
    would have failed to reproduce for the next reader who cloned the repository.

    A contract identity whose digest depends on the checkout that computed it is not
    an identity. So contract inputs are hashed with CRLF normalised to LF, which
    makes the digest the same in every checkout, and the definition is also WRITTEN
    with LF endings so the two agree in the first place.
    """
    data = path.read_bytes()
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def canonical_digest(value: Any) -> str:
    """The identity algorithm, applied to any JSON value.

    `sha256(UTF8(json.dumps(inputs, sort_keys=True, separators=(',', ':'),
    ensure_ascii=True)))` -- the algorithm the lock itself declares, reused verbatim
    so a reader who can reproduce v1's identity can reproduce v2's the same way.
    """
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def tree_digest(rel: str) -> dict[str, Any]:
    """A digest over every file in a directory tree, path-sorted.

    Paths are included so a rename moves the digest, and the file count is recorded
    so a tree that silently emptied is visible rather than hashing to something.
    """
    root = ROOT / rel
    if not root.is_dir():
        return {"path": rel, "digest": None, "files": 0, "error": "directory missing"}
    rows = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            rows.append([path.relative_to(root).as_posix(), sha256_file(path)])
    return {"path": rel, "digest": canonical_digest(rows), "files": len(rows)}


def python_identity() -> dict[str, Any]:
    """The Python identity: the interpreter that runs the kernel broker.

    Read from the RUNNING interpreter (`sys.executable`, `platform.python_version`)
    rather than from a PATH lookup, because a PATH lookup can resolve to a different
    Python than the one a kernel would start under.
    """
    return {
        "python_version": platform.python_version(),
        "python_executable": sys.executable,
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
    }


def jupyter_identity() -> dict[str, Any]:
    """The Jupyter identity: the distributions that decide the kernel protocol.

    SEPARATE FROM python_identity ON PURPOSE, and the separation is not pedantic.
    A Python upgrade with the same ipykernel is a different interpreter; an ipykernel
    upgrade with the same Python is a different PROTOCOL. Both change what an IPY
    case observes, and a single combined field would hide which one moved.

    Read through `importlib.metadata`, so the values are the distributions actually
    importable by this interpreter rather than whatever a shell would find first.
    """
    import importlib.metadata as md
    packages = {}
    for dist in ("ipython", "ipykernel", "jupyter-client", "jupyter-core",
                 "traitlets", "pyzmq"):
        try:
            packages[dist] = md.version(dist)
        except md.PackageNotFoundError:
            packages[dist] = "ABSENT"
    return packages


def implementation_commit() -> dict[str, Any]:
    """The implementation's own git revision and dirty state.

    The dirty state is recorded but NOT part of the identity digest: an uncommitted
    edit in a worktree would otherwise make every measurement in that worktree
    unreproducible by identity, which would push writers toward committing
    half-finished work to get a stable hash. The ARTIFACTS are digested instead
    (extension_package_digests, artifact_sha256), so a real change is still caught --
    by what was built rather than by whether it was committed.
    """
    def run(*args: str) -> str | None:
        proc = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)
        return proc.stdout.strip() if proc.returncode == 0 else None

    return {
        "commit": run("rev-parse", "HEAD"),
        "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(run("status", "--porcelain")),
    }


def lock_inputs() -> dict[str, Any]:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    deployment = lock["deployment"]
    return {"inputs": deployment["inputs"], "identity": deployment["identity"],
            "algorithm": deployment["identity_algorithm"], "trust_model": lock.get("trust_model"),
            "trust_model_statement": deployment.get("trust_model_statement")}


def runtime_inputs(probe: dict[str, Any] | None) -> dict[str, Any]:
    """Build the RuntimeDeploymentIdentity input set.

    Every reused field is re-checked against disk where a file backs it, and the
    check result is carried as a SEPARATE `*_verified` field so a stale lock value
    cannot silently enter the identity. The verified digest is what goes into the
    hash; the recorded one is kept beside it for the diff.
    """
    lock = lock_inputs()
    inputs = lock["inputs"]
    verified: dict[str, Any] = {}

    def reuse(field: str, lock_key: str) -> Any:
        value = inputs.get(lock_key)
        verified[f"{field}_recorded"] = value
        return value

    out: dict[str, Any] = {}
    out["upstream_commit"] = reuse("upstream_commit", "upstream_commit")
    out["upstream_repository"] = reuse("upstream_repository", "upstream_repository")
    out["artifact_sha256"] = reuse("artifact_sha256", "artifact_sha256")
    out["launcher_realpath"] = reuse("launcher_realpath", "launcher_realpath")
    out["dependency_lock_sha256"] = reuse("dependency_lock_sha256", "dependency_lock_sha256")
    out["node_version"] = reuse("node_version", "node_version")
    out["package_manager_version"] = reuse("package_manager_version", "package_manager_version")
    out["host_profile_digest"] = reuse("host_profile_digest", "host_profile_digest")
    out["agent_preset_digest"] = reuse("agent_preset_digest", "agent_preset_digest")
    out["agent_preset_id"] = reuse("agent_preset_id", "agent_preset_id")
    out["resolved_plugin_graph_digest"] = reuse(
        "resolved_plugin_graph_digest", "resolved_plugin_graph_digest")
    out["model_and_provider_capabilities_digest"] = reuse(
        "model_and_provider_capabilities_digest", "model_and_provider_capabilities_digest")
    out["isolation_image_or_policy_digest"] = reuse(
        "isolation_image_or_policy_digest", "isolation_image_or_policy_digest")
    out["os_and_architecture"] = reuse("os_and_architecture", "os_and_architecture")
    out["authority_policy_digest"] = reuse("authority_policy_digest", "authority_policy_digest")

    # The trust-model statement: the lock's own text, so the identity is bound to
    # what the deployment CLAIMS, not only to what it contains.
    out["trust_model_statement"] = lock["trust_model_statement"]
    out["trust_model_name"] = lock.get("trust_model")

    # NEW: the implementation revision and the machine's Python/Jupyter identities.
    impl = implementation_commit()
    out["implementation_commit"] = impl["commit"]
    out["python_identity"] = python_identity()
    out["jupyter_identity"] = jupyter_identity()

    # NEW: the local extension package digests -- the built trees the profile loads.
    out["extension_package_digests"] = {
        rel: tree_digest(rel)
        for rel in (
            "packages/dsh-daily-work/lib",
            "packages/dsh-ipython/lib",
        )
    }

    # NEW (probe): the resolved host graph and the per-Agent tool catalog. Absent
    # until a boot has measured them, and the ABSENCE is recorded as a value rather
    # than omitted, so an identity computed without a probe is distinguishable from
    # one computed with a probe that found nothing.
    if probe is None:
        out["resolved_host_graph_measured"] = "NOT_MEASURED-no-probe-supplied"
        out["agent_tool_catalog_digest"] = "NOT_MEASURED-no-probe-supplied"
        out["agent_tool_catalog_order_digest"] = "NOT_MEASURED-no-probe-supplied"
        out["agent_tool_count"] = "NOT_MEASURED-no-probe-supplied"
    else:
        host = probe.get("hostGraph") or {}
        catalog = probe.get("agentCatalog") or {}
        out["resolved_host_graph_measured"] = host.get("digest")
        out["agent_tool_catalog_digest"] = catalog.get("schemaDigest")
        out["agent_tool_catalog_order_digest"] = catalog.get("orderDigest")
        out["agent_tool_count"] = catalog.get("toolCount")
        verified["probe_dsh_home"] = probe.get("dshHome")
        verified["probe_preset_default_id"] = probe.get("presetDefaultId")

    return {"inputs": out, "verified": verified, "lock_identity": lock["identity"],
            "algorithm": lock["algorithm"]}


def contract_inputs(definition_digest: str, runner_digests: dict[str, Any]) -> dict[str, Any]:
    return {
        "acceptance_definition_digest": definition_digest,
        "qualification_runner_digests": runner_digests,
    }


def checkout_reproducibility() -> dict[str, Any]:
    """Would a FRESH CHECKOUT compute the same contract digests?

    THE CHECK THAT WOULD HAVE CAUGHT THIS SLICE'S OWN DEFECT. The first build of the
    v2 definition wrote CRLF endings, so its on-disk digest was `06a41c99...` while
    git stored the LF form `115aa092...`. The contract identity would then have been
    unreproducible for the next reader who cloned the repository -- the same defect
    that already left three v1 evidence entries unreproducible.

    This asks git what it will hand a fresh checkout (`git cat-file -p` on the
    canonical blob) and compares the line-ending-normalised digest with the one
    computed from the working tree. A mismatch means the identity describes this
    checkout rather than the repository.
    """
    rows = []
    for rel in [DEFINITION, PROVENANCE] + [ROOT / r for r in CONTRACT_RUNNER_FILES]:
        rel_path = rel.relative_to(ROOT).as_posix()
        if not rel.is_file():
            rows.append({"path": rel_path, "reproducible": None, "why": "file missing"})
            continue
        disk = canonical_file_digest(rel)
        # `git cat-file -e HEAD:<path>` asks whether the file is IN THE REPOSITORY.
        # A file that exists only in the working tree is not yet available to a fresh
        # checkout, and that is a DIFFERENT condition from a digest that does not
        # match -- conflating the two would report an uncommitted file as a corrupted
        # identity. This slice's own runner files are untracked until they are
        # committed, so the distinction is load-bearing rather than theoretical.
        in_head = subprocess.run(["git", "cat-file", "-e", f"HEAD:{rel_path}"],
                                 cwd=ROOT, capture_output=True)
        if in_head.returncode != 0:
            rows.append({
                "path": rel_path,
                "canonical_digest_disk": disk,
                "reproducible": None,
                "committed": False,
                "why": ("not committed yet, so no fresh checkout has it. This is NOT a "
                        "reproducibility failure -- it resolves when the file is committed. "
                        "It IS a reason the identity cannot be finalised before the commit."),
            })
            continue
        cat = subprocess.run(["git", "cat-file", "-p", f"HEAD:{rel_path}"],
                             cwd=ROOT, capture_output=True)
        from_git = hashlib.sha256(cat.stdout.replace(b"\r\n", b"\n")).hexdigest()
        rows.append({
            "path": rel_path,
            "canonical_digest_disk": disk,
            "canonical_digest_git": from_git,
            "committed": True,
            "reproducible": disk == from_git,
        })
    committed = [r for r in rows if r.get("committed")]
    uncommitted = [r["path"] for r in rows if r.get("committed") is False]
    return {
        "why": ("A contract digest that depends on the checkout that computed it is not an "
                "identity. `.gitattributes` declares `*.json text eol=lf` with "
                "core.autocrlf=true, so on-disk CRLF becomes LF in git and the two digests "
                "diverge unless line endings are normalised."),
        "all_committed_inputs_reproducible": all(r["reproducible"] for r in committed),
        "committed_inputs": len(committed),
        "uncommitted_inputs": uncommitted,
        "files": rows,
    }


def staleness_report(model: dict[str, Any]) -> dict[str, Any]:
    """Is the filed result still bound to the identity the tree currently has?

    WHY THIS EXISTS, AND WHY IT IS NOT A CONTRADICTION.

    `implementation_commit` is a runtime identity input, so the identity CHANGES when
    the tree is committed -- including when the commit is the one that ADDS the result
    directory. So a result filed at revision X names identity X, and the commit that
    carries it moves the tree to Y. The result is then a true statement about X and not
    about Y.

    That is the intended behaviour, not a bug: V3 requires every claim carry the
    identity it was measured under, and a result for one revision is not a result for
    another. The same property held in v1, which is why v1's lock carries an
    `identity_history` and why its identity moved whenever an input moved.

    What would be a defect is a reader being UNABLE TO TELL. So this reports the
    comparison explicitly rather than leaving a stale identity-named directory sitting
    in the tree looking current.
    """
    current = model["qualification_contract"]["qualification_contract_identity"]
    filed_dirs = sorted(
        p.name for p in RESULTS_ROOT.glob("trusted-local-v2.*")
        if (p / "identity.json").is_file()
    )
    rows = []
    for name in filed_dirs:
        try:
            filed = json.loads((RESULTS_ROOT / name / "identity.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            rows.append({"directory": name, "current": None, "why": f"unreadable: {exc}"})
            continue
        filed_id = filed["qualification_contract"]["qualification_contract_identity"]
        filed_rt = filed["runtime_deployment_identity"]
        rows.append({
            "directory": name,
            "filed_contract_identity": filed_id,
            "filed_runtime_identity": filed_rt,
            "is_current": filed_id == current,
            "contract_matches": filed_id == current,
            "runtime_matches": filed_rt == model["runtime_deployment_identity"],
            "why": ("current" if filed_id == current else
                    "STALE: this result was filed at a different revision or definition. It "
                    "remains a true statement about the identity it names, and it is NOT a "
                    "result for the current tree. Re-derive with `--init-results` after the "
                    "final integration commit."),
        })
    return {
        "current_contract_identity": current,
        "current_runtime_identity": model["runtime_deployment_identity"],
        "filed_results": rows,
        "all_current": all(r.get("is_current") for r in rows) if rows else None,
        "note": ("`implementation_commit` is a runtime identity input, so committing a result "
                 "directory moves the identity that directory names. This is intended: a "
                 "result must name the revision it was measured at. The consequence to state "
                 "plainly is that a result filed before the FINAL integration commit is stale "
                 "by construction, and the root agent re-derives at integration."),
    }


def compute(probe_path: str | None) -> dict[str, Any]:
    probe = None
    probe_error = None
    if probe_path is not None:
        try:
            probe = json.loads(Path(probe_path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            probe_error = f"{type(exc).__name__}: {exc}"

    rt = runtime_inputs(probe)
    runtime_identity = canonical_digest(rt["inputs"])

    definition_digest = canonical_file_digest(DEFINITION) if DEFINITION.is_file() else None
    provenance_digest = canonical_file_digest(PROVENANCE) if PROVENANCE.is_file() else None
    runner_digests = {
        rel: (canonical_file_digest(ROOT / rel) if (ROOT / rel).is_file() else None)
        for rel in CONTRACT_RUNNER_FILES
    }
    ct = contract_inputs(definition_digest, runner_digests)
    contract_identity = canonical_digest({
        "runtime_deployment_identity": runtime_identity,
        **ct,
    })

    return {
        "schema_version": 1,
        "kind": "TRUSTED_LOCAL_V2_QUALIFICATION_IDENTITY_NOT_A_DSH_ARTIFACT",
        "algorithm": rt["algorithm"],
        "algorithm_note": (
            "The lock's own declared algorithm, reused verbatim so a reader who can "
            "reproduce v1's identity reproduces v2's the same way: "
            "sha256(UTF8(json.dumps(inputs, sort_keys=True, separators=(',',':'), "
            "ensure_ascii=True)))."
        ),
        "runtime_deployment_identity": runtime_identity,
        "runtime_inputs": rt["inputs"],
        "runtime_verification": rt["verified"],
        "v1_lock_identity": rt["lock_identity"],
        "qualification_contract": {
            "contract_id": f"trusted-local-v2.{contract_identity[:12]}",
            "qualification_contract_identity": contract_identity,
            "acceptance_definition_path": "qualification/specs/acceptance-spec.trusted-local-v2.definition.json",
            "acceptance_definition_digest": definition_digest,
            "provenance_path": "qualification/specs/acceptance-spec.trusted-local-v2.provenance.json",
            "provenance_digest": provenance_digest,
            "qualification_runner_digests": runner_digests,
            "results_location": f"qualification/results/trusted-local-v2.{contract_identity[:12]}/",
        },
        "field_provenance": RUNTIME_INPUT_SOURCES,
        "checkout_reproducibility": checkout_reproducibility(),
        "staleness": None,  # filled below, once the model is assembled
        "probe_path": probe_path,
        "probe_error": probe_error,
        "the_split": {
            "runtime_inputs_include_any_verdict": False,
            "runtime_inputs_include_any_evidence_path": False,
            "contract_inputs_include_any_verdict": False,
            "contract_inputs_include_any_evidence_path": False,
            "statement": (
                "Neither hash's input set contains a status, a verdict or an evidence "
                "path. Filing a result writes a file under the results directory, which "
                "is an input of neither hash. That is the property that makes the split "
                "work, and it is checked rather than asserted."),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="compute the trusted-local-v2 identities")
    parser.add_argument("--json", action="store_true", help="print the whole model as JSON")
    parser.add_argument("--probe", default=None,
                        help="a probe.json from qualification/runners/v2-identity-probe.mjs")
    parser.add_argument("--write", action="store_true",
                        help="write identity.json into the results directory")
    args = parser.parse_args()

    model = compute(args.probe)
    # Filled here rather than inside compute(), because the report reads the results
    # directory and `compute` is also called on mutated copies of the tree during the
    # mutation test, where the comparison would be noise.
    model["staleness"] = staleness_report(model)

    # The structural property, checked on the computed model rather than asserted.
    problems: list[str] = []
    for label, bucket in (("runtime", model["runtime_inputs"]),
                          ("contract", model["qualification_contract"])):
        blob = json.dumps(bucket, ensure_ascii=True).lower()
        for banned in ('"status"', '"verdict"', '"evidence"', '"evidence_path"'):
            if banned in blob:
                problems.append(f"{label} inputs contain {banned}")

    if args.write:
        out_dir = RESULTS_ROOT / f"trusted-local-v2.{model['qualification_contract']['qualification_contract_identity'][:12]}"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "identity.json").write_text(
            json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
            newline="\n")
        print(f"wrote {out_dir / 'identity.json'}")

    if args.json:
        print(json.dumps(model, indent=2, ensure_ascii=False))
        return 1 if problems else 0

    print(f"algorithm                       {model['algorithm']}")
    print("")
    print(f"RuntimeDeploymentIdentity       {model['runtime_deployment_identity']}")
    print(f"QualificationContractIdentity   {model['qualification_contract']['qualification_contract_identity']}")
    print(f"contract_id                     {model['qualification_contract']['contract_id']}")
    print(f"results_location                {model['qualification_contract']['results_location']}")
    print("")
    print(f"acceptance definition digest    {model['qualification_contract']['acceptance_definition_digest']}")
    print(f"v1 lock identity (unchanged)    {model['v1_lock_identity']}")
    print(f"probe                           {args.probe or 'none supplied -- measured inputs are NOT_MEASURED'}")
    print("")
    print("runtime inputs, by source:")
    for row in RUNTIME_INPUT_SOURCES:
        mark = {"lock": "reused", "derived": "NEW   ", "probe": "NEW   "}[row["source"]]
        print(f"  [{mark}] {row['field']:38s} <- {row['v3_term']}")
    print("")
    reused = [r for r in RUNTIME_INPUT_SOURCES if r["source"] == "lock"]
    print(f"reused from deployment.inputs: {len(reused)}/{len(RUNTIME_INPUT_SOURCES)} V3 terms")
    print(f"new inputs added: {len(RUNTIME_INPUT_SOURCES) - len(reused)}")
    print("")
    repro = model["checkout_reproducibility"]
    print(f"contract inputs reproducible from a fresh checkout: "
          f"{repro['all_committed_inputs_reproducible']} "
          f"({repro['committed_inputs']} committed, {len(repro['uncommitted_inputs'])} uncommitted)")
    for row in repro["files"]:
        if row.get("reproducible") is False:
            print(f"  NOT REPRODUCIBLE: {row['path']}  "
                  f"disk={str(row.get('canonical_digest_disk'))[:16]} "
                  f"git={str(row.get('canonical_digest_git'))[:16]}")
    for path in repro["uncommitted_inputs"]:
        print(f"  UNCOMMITTED (resolves on commit, not a failure): {path}")
    print("")
    if not repro["all_committed_inputs_reproducible"]:
        problems.append(
            "a COMMITTED contract input does not reproduce from a fresh checkout, so the "
            "identity describes this working tree rather than the repository")
    print("")
    stale = model["staleness"]
    print("filed results, and whether they are current:")
    if not stale["filed_results"]:
        print("  (none filed yet)")
    for row in stale["filed_results"]:
        mark = "current" if row.get("is_current") else "STALE  "
        print(f"  [{mark}] {row['directory']}")
        if not row.get("is_current"):
            print(f"           filed  ={str(row.get('filed_contract_identity'))[:16]}")
            print(f"           current={stale['current_contract_identity'][:16]}")
    print("  NOTE: implementation_commit is a runtime identity input, so the commit that")
    print("        carries a result moves the identity that result names. A result filed")
    print("        before the final integration commit is stale BY CONSTRUCTION; re-derive")
    print("        with `file-result.py --init-results` after integration.")
    if problems:
        print("STRUCTURAL PROBLEM -- an identity input set contains a status/verdict/evidence field:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print("neither identity input set contains a status, verdict or evidence path.")
    print("This computes identities. It does not judge any acceptance case.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
