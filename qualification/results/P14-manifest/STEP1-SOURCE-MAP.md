# P1.8 STEP 1 — the source map of the self-referential identity

Written and committed BEFORE any fix, so that if this slice dies the map survives.
Every line number below was read from this worktree at
`2e1b2c2d3657407ce7ac621b07b3307d3edd8df4` (branch `wt/p14`).

---

## (a) Every input `compatibility.lock.json` hashes

`deployment.identity` =
`sha256(UTF8(json.dumps(inputs, sort_keys=True, separators=(',',':'), ensure_ascii=True)))`
declared at `compatibility.lock.json` → `deployment.identity_algorithm`, and
implemented three times over the same map:

- `helpers/rederive-identity.py:68-73` (`identity_digest`)
- `helpers/doctor.py:91-96` (`identity_digest`)
- `qualification/runners/qualification-identity.py:206-214` (`canonical_digest`)

The 22 inputs, and where each value comes from:

| # | input | value source | file-derived? |
|---|---|---|---|
| 1 | `upstream_repository` | literal | no |
| 2 | `upstream_commit` | literal | no |
| 3 | `upstream_patchset_sha256` | literal `none-…` | no |
| 4 | `artifact_sha256` | **sha256 of the built launcher** | **yes — outside the tree** |
| 5 | `launcher_realpath` | literal path `D:\DSH\src\dsh-src\apps\cli\lib\bin.js` | no (a path, not a digest) |
| 6 | `launcher_args_redacted` | literal | no |
| 7 | `node_version` | literal `v24.18.0` | no |
| 8 | `package_manager_version` | literal `11.7.0` | no |
| 9 | `dependency_lock_sha256` | **sha256 of `D:\DSH\src\dsh-src\pnpm-lock.yaml`** | **yes — outside the tree** |
| 10 | `native_binary_digests` | literal | no |
| 11 | `os_and_architecture` | literal | no |
| 12 | `isolation_image_or_policy_digest` | literal | no |
| 13 | `host_profile_digest` | **sha256 of `profiles/daily-candidate/cordis.patch.yml`** | **yes — THIS tree** |
| 14 | `agent_preset_id` | literal | no |
| 15 | `agent_preset_digest` | **sha256 of `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`** | **yes — THIS tree** |
| 16 | `resolved_plugin_graph_digest` | **sha256 of `qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml`** | **yes — THIS tree, and STALE** |
| 17 | `model_and_provider_capabilities_digest` | literal | no |
| 18 | `request_accounting_policy_digest` | literal | no |
| 19 | `acceptance_spec_sha256` | **sha256 of `qualification/specs/acceptance-spec.json`** | **yes — THIS tree** |
| 20 | `trusted_local_acceptance_spec_sha256` | **sha256 of `qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json`** | **yes — THIS tree** |
| 21 | `enabled_conditional_gate_ids` | literal `[]` | no |
| 22 | `authority_policy_digest` | literal | no |
| 23 | `data_schema_version` | literal | no |

## (b) Which inputs are computed from the SAME TREE they are recorded in

**Six.** Numbers 4, 9, 13, 15, 16, 19, 20 — of which five (13, 15, 16, 19, 20)
hash files that are **inside this repository**, and the lock that records them is
**also inside this repository**.

That is the self-reference V5 §14 names:

```
the lock commits  ->  a digest of a file in the same commit
editing that file ->  moves the digest
adopting the move ->  another edit to the lock
                  ->  which is another commit
```

Measured, this is not hypothetical. The identity has moved four times in this
wave's history and the lock's own `deployment.identity_note` records each one
with the input that moved. The two current tools disagree RIGHT NOW:

```
$ python helpers/rederive-identity.py
recorded identity  : 533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb
recomputed identity: 709a0fcee45b45f4da218d04e690c9955d23c0d1a1c83b45e022aa9c24c45388

1 input(s) moved:
  host_profile_digest
    CHANGED: profiles/daily-candidate/cordis.patch.yml
    recorded: 0e8e370e06375ad4a289fa36f783232d
    computed: 4e3aa20cbc23b8cedbfc7205aac0756f
```

The moving input is S1's `includeShippedRoot: false` commit (`8941ad5`) — a
CORRECT change (round-2 brief §1 authorizes exactly it) that nonetheless
invalidated the identity, because the identity is computed over the file that
the change edited. A correct change moving the identity is the definition of the
defect.

### The sharpest instance, already measured by root

`qualification/results/ROOT-round2/identity-input-unchecked-and-stale.md`
records, and I re-measured here:

1. **`resolved_plugin_graph_digest` is checked by NO tool.**
   `grep -c resolved_plugin_graph_digest helpers/rederive-identity.py helpers/doctor.py`
   → `0` and `0`. `qualification-identity.py:340-341` REUSES it verbatim from the
   lock rather than recomputing it, so it propagates rather than validates.
2. **Its basis is pre-F3 and asserts the defect CMP-02 exists to catch.**
   ```
   $ sha256sum qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml
   23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b
   $ python -c "...lock...['resolved_plugin_graph_digest']"
   23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b
   ```
   The digest matches its file. Its file is from `786edb1`, before F3, and still
   contains (`dump-config-daily-candidate.yml:112-116`):
   ```
   - id: sandbox-policy
     config:
       mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
   ```
   while the current tree resolves `mode: danger-full-access`
   (`profiles/daily-candidate/cordis.patch.yml`, the F3 row). So an identity input
   currently certifies a graph in which the deployment resolves to the CONFINING
   mode. Unchecked AND wrong is worse than unchecked.

3. **`build-gates.py` re-stamps the CURRENT identity onto historical rows.**
   `qualification/runners/build-gates.py:207` reads `deployment.identity`, and
   `:250` writes it onto every PASS row. Measured on the committed artifact:
   ```
   $ python -c "import json,collections; g=json.load(open('qualification/gates.json'))..."
   total gates 104
   Counter({'PASS': 84, 'NOT_RUN': 10, 'NOT_APPLICABLE': 6, 'FAIL': 3, 'BLOCKED_EXTERNAL': 1})
   identities on PASS rows: Counter({'ece4037a9d5bbb014aa5a8395ed15531715a11949f2aa687166fcfeb5717576f': 84})
   ```
   All 84 PASS rows currently carry `ece4037a…`, which is the identity that was
   current when they were regenerated. Running the generator today would stamp
   `533c8cb0…` (or `709a0fce…`) onto all 84 — re-labelling measurements with an
   identity they were not taken under. This is the concrete harm: not a stale
   hash, but a FALSE ATTRIBUTION created by the generator itself.

## (c) The tools that must move to the new split

| tool | current job | what the split does to it |
|---|---|---|
| `helpers/rederive-identity.py` | recomputes `deployment.inputs` from files in THIS tree, refuses to write the lock | stops being the authority for the deployment identity; becomes the re-derivation of `compatibility.expected.json` (requirements only, no build-derived digests) |
| `helpers/doctor.py` | checks each recorded input against disk; recomputes the identity | checks `compatibility.expected.json` against the machine (Node/pnpm/Python/upstream) and checks a GENERATED manifest's self-consistency; never re-stamps |
| `qualification/runners/build-gates.py` | reads `deployment.identity` and stamps it onto every PASS row | must stamp the identity the row's EVIDENCE was measured under, not the identity that is current at generation time |
| `qualification/runners/qualification-identity.py` | computes `RuntimeDeploymentIdentity` from `deployment.inputs`, reusing the stale graph digest verbatim | re-pointed at the generated `BuildManifest`; the graph digest stops being a hand-maintained lock field and becomes a freshly-observed measurement |
| `qualification/runners/v2-identity-probe.mjs` | measures the live host graph + tool catalog, but writes a probe artifact that nothing binds | becomes the fresh-observation half of the manifest generator |

## (d) The two artifacts V5 §14 splits this into

**A. `compatibility.expected.json`** — checked in, describes REQUIREMENTS:
upstream SHA/release, supported Node/pnpm/Python ranges, product contract
version, acceptance definition version. It contains **no digest of any file in
this repository**, so no edit to a profile, a preset, a spec or a graph dump can
move it.

**B. a generated `BuildManifest`** — stored as a qualification/release artifact,
NOT a source input of the candidate it describes. It carries the build-derived
facts (commit + tree, launcher digest, package digests, Python env digest,
resolved graph **with realpaths**, model tool catalog, hard cap, presentation
mode). Then:

```
RuntimeDeploymentIdentity     = H(canonical BuildManifest)
QualificationContractIdentity = H(RuntimeDeploymentIdentity
                                  + acceptanceDefinitionDigest
                                  + releaseRunner/metaGateDigest)
```

and result/evidence files bind to `QualificationContractIdentity`.

## (e) What is NOT established by this step

1. No manifest has been generated yet; this file is the map, not the fix.
2. Whether any consumer treats `resolved_plugin_graph_digest` as load-bearing was
   not audited beyond `qualification-identity.py` reusing it verbatim.
3. `acceptance_spec_sha256` (input 19) points at `qualification/specs/acceptance-spec.json`,
   the OLD 112-case spec, retained deliberately as a historical input. Whether it
   should remain in a requirements file is a decision recorded in the report, not here.
