# P1.8 — the deployment identity now describes the BUILD, not itself

**Slice:** V5 §14 (identity must describe the actual build) + §18 (ID-FRESH,
GRAPH-REALPATH).
**Worktree/branch:** `D:\DSH\work\wt-p14` / `wt/p14`.
**Manifest commit:** `c061e09dc09fa11c6b90fa7e026f54e3cf60e399`, tree
`2fd8448deb9e7114d4e57d5827ca28951f834e31`.

---

## 0. THE ONE-SENTENCE FINDING

The old identity hashed five files in the same commit that recorded the hash, so
every authorized edit to a profile, preset, spec or dump moved it and adopting the
move was another edit; it is now split into a checked-in requirements file that no
edit to the deployment can move, and a generated manifest that describes one build
and is bound to the commit it was **measured at**.

---

## 1. THE SPLIT, STATED AS WHAT HOLDS WHAT

### A. `compatibility.expected.json` — REQUIREMENTS (new, checked in)

Holds **what a deployment must BE**. Measured, not asserted: it contains exactly
**one** sha256-shaped value, and it is allowlisted with a reason
(`acceptance_definition.v1_is_frozen_and_not_superseded_on_disk.sha256`, the frozen
v1 snapshot that `verify-freeze.py` proves cannot change). So:

```
editing a profile / preset / spec / dump / package / runner
  -> does NOT move compatibility.expected.json
```

Its sections: `upstream` (commit + release + the no-patchset requirement),
`supported_toolchain` (Node range, exact pnpm, Python floor), `product_contract`
(trusted-local statement, hard child cap 30, `native` presentation requirement, the
forbidden-mechanisms list), `acceptance_definition` (v2 version, 110 cases, 11
families, verdict vocabulary, the frozen v1 pin, the no-migration rule),
`deployment_requirements` (built launcher, single mode, read-only checkout, no
isolation domain, no live provider), `lineage_of_deployment_inputs`, and
`self_reference_audit`.

### B. The generated `BuildManifest` — one BUILD (new, generated)

`qualification/results/trusted-local-v3.a091cb594902/build-manifest.json`. Every
field V5 §14 names, plus the two identities:

```
RuntimeDeploymentIdentity      c969808e7633162526b3a93d7ea398ce2e63b0e9a10fac13e3f42fad257d65de
QualificationContractIdentity  a091cb5949029fa709e67aa2cfa5767e3346e5150f055636800fab626f10f442
contract_id                    trusted-local-v3.a091cb594902
```

Result/evidence files bind to `QualificationContractIdentity`; the results location
is a directory a filed result writes into, which is an input of **neither** hash —
checked structurally in the generator, not asserted.

**`build` (hashed)** vs **`qualifiers` (not hashed)**, and the second half of that
split was forced by a defect I reproduced inside my own fix:

| `build` — hashed | `qualifiers` — recorded, NOT hashed |
|---|---|
| `project_git_commit`, `project_git_tree` | `git_dirty_at_observation` (dirty flag, path count, branch) |
| `upstream_sha`, `upstream_release`, `pinned_checkout` | `git_live_at_generation` (commit, dirty, moved-since) |
| `lockfile` (path + digest + recomputed) | `artifact_staleness` (fingerprint comparison) |
| `toolchain` (node, pnpm, platform) | |
| `python_environment` (realpath, impl, version, distributions, digest) | |
| `built_launcher` (path, sha256, lock agreement) | |
| `package_digests` (both `lib/` trees, path-sorted) | |
| `python_source_digests` (broker, data client) | |
| `embedded_python_clients` (the bridge client) | |
| `profile`, `agent_preset` (path, digest, lock agreement, installed copy) | |
| `resolved_plugin_graph` (**freshly observed, with realpaths**) | |
| `model_tool_catalog` (27 names in header order, schema + order digests) | |
| `hard_child_cap`, `presentation_mode` | |

**Why the dirty flag is a qualifier, measured.** The first version hashed
`project_git_dirty_path_count`. Another writer creating one unrelated untracked file
moved `RuntimeDeploymentIdentity` while the launcher, profile, packages, graph and
catalog were all byte-identical. An identity that moves when nothing it describes
moves is the defect this slice exists to remove. The precedent is already recorded
here, in `qualification-identity.py`'s `implementation_commit`: the dirty state is
recorded but NOT hashed, because an uncommitted edit would otherwise make every
measurement unreproducible and would push writers toward committing half-finished
work for a stable hash. The artifacts are hashed instead, so a real change is still
caught. **Verified**: two consecutive generations with a volatile untracked file
created between them produced the **same** identity and a byte-identical manifest.

---

## 2. A REAL GENERATED MANIFEST (abridged, with the load-bearing parts verbatim)

```json
{
  "schema_version": 1,
  "kind": "DSH_BUILD_MANIFEST_NOT_A_DSH_ARTIFACT",
  "generator": { "path": "qualification/runners/build-manifest.py", "sha256": "8253dbe9..." },
  "observation": {
    "ran_at": "2026-09-20T13:2x:xxZ", "verdict": "OBSERVED",
    "dsh_home": "D:/DSH/home/p14", "profile": "daily", "boot_cwd": "C:/Windows/Temp"
  },
  "build": {
    "project_git_commit": "c061e09dc09fa11c6b90fa7e026f54e3cf60e399",
    "project_git_tree": "2fd8448deb9e7114d4e57d5827ca28951f834e31",
    "project_git_bound_to": "THE COMMIT RECORDED HERE, read at OBSERVATION time. Not the
                            current HEAD of this or any other checkout: twelve writers
                            edit this tree concurrently, so the commit moves under the
                            measurement and the manifest states which one it saw.",

    "resolved_plugin_graph": {
      "source": "FRESH_OBSERVATION_FROM_A_LIVE_BOOT",
      "row_count": 177, "active_row_count": 146,
      "resolved_row_count": 176, "loader_builtin_row_count": 1,
      "unresolved_rows": [],
      "composition_digest": "...", "resolved_url_digest": "...",
      "realpath_digest": "5014d06e2d9c92d990fec01f47df6225a7bce93629b99b7f9aff8ca8a64c83fe",
      "extension_rows": [
        {"name": "dsh-daily-work/host", "realpath": "D:/DSH/work/wt-p14/packages/dsh-daily-work/lib/host-plugin.js"},
        {"name": "dsh-ipython/host",   "realpath": "D:/DSH/work/wt-p14/packages/dsh-ipython/lib/host-plugin.js"}
        // 9 rows in total, all inside D:/DSH/work/wt-p14
      ],
      "superseded_lock_field": {
        "field": "deployment.inputs.resolved_plugin_graph_digest",
        "value": "23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b",
        "basis": "qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml",
        "checked_by_any_tool": false,
        "stale_reason": "the dump is from 786edb1, before F3, and its sandbox-policy row
                         still reads mode: workspace-write."
      }
    },

    "model_tool_catalog": {
      "source": "FRESH_OBSERVATION_FROM_A_LIVE_BOOT",
      "tool_count": 27,
      "names_in_header_order": ["work","read","write","edit","glob","grep","job_output",
        "job_list","job_kill","skill","ask_user_question","web_search","web_fetch",
        "present","ipython","read_image","send_message","interrupt_agent","list_agents",
        "todo_write","workflow","get_goal","create_goal","update_goal","exit_plan_mode",
        "subagent_fork","subagent"],
      "schema_digest": "...", "order_digest": "02a593f1cc11d534...",
      "has_run_code": false
    },

    "hard_child_cap": {
      "requirement": 30,
      "enforced_by": "packages/dsh-daily-work/src/capacity.ts -> HARD_CHILD_CAPACITY",
      "mounted_subagent_row": { "maxActiveSubagents": 10, "maxDepth": 1 }
    },

    "presentation_mode": {
      "requirement": "native",
      "measured_from": "the absence of `run_code` in a non-empty model tool catalog",
      "measured_value": "native"
    },

    "embedded_python_clients": {
      "bridge_python_client": {
        "sha256": "b78cc5e3bb7df19e3f0c418fae2044f843ccfa661ed624cdd56808195efbf573",
        "chars": 11975, "lines": 340,
        "first_line": "\"\"\"DSH native-tool bridge client, injected into the kernel by the host.",
        "last_line": "tools = _ToolNamespace(_channel)",
        "extracted_from": "packages/dsh-ipython/lib/bridge.js",
        "extraction": "node imported the built module and hashed the VALUE of the export"
      }
    },

    "python_source_digests": {
      "broker":      { "path": "packages/dsh-ipython/src/broker.py",        "sha256": "6443868b..." },
      "data_client": { "path": "packages/dsh-daily-work/src/dsh_data_client.py", "sha256": "c152f0ad..." }
    },

    "python_environment": {
      "sys_executable_realpath": "C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe",
      "python_implementation": "cpython", "python_version": "3.14.3",
      "distributions": { "ipython": "9.16.1", "ipykernel": "7.3.0",
                         "jupyter-client": "8.10.0", "pyzmq": "27.2.0" },
      "digest": "..."
    },

    "built_launcher": {
      "path": "D:\\DSH\\src\\dsh-src\\apps\\cli\\lib\\bin.js",
      "sha256": "69c49c871735dc7ee81ec51f266bbec129f075fd5066e046374f4b13ab02a705",
      "sha256_matches_lock": true
    }
  },
  "gaps": [],
  "identity_computable": true,
  "runtime_deployment_identity": "c969808e7633162526b3a93d7ea398ce2e63b0e9a10fac13e3f42fad257d65de",
  "qualification_contract": {
    "contract_id": "trusted-local-v3.a091cb594902",
    "qualification_contract_identity": "a091cb5949029fa709e67aa2cfa5767e3346e5150f055636800fab626f10f442",
    "results_location": "qualification/results/trusted-local-v3.a091cb594902/"
  }
}
```

---

## 3. THE GRAPH IS FRESHLY OBSERVED, AND IT HAS REALPATHS

V5: *"Graph dump must be freshly observed from exact built candidate. Static import
scan remains useful but is NOT the runtime graph proof."*

**How it is obtained.** A live boot of the built launcher over this tree's installed
profile, with one inserted row: the probe. Every composition row is then resolved
through **the same resolver the loader uses** —
`loader.internal.resolveSync(baseUrl, { specifier })` on this Node 24 build — and
`realpathSync(fileURLToPath(url))` collapses the profile's `link:` symlinks to the
tree they actually point at.

```
SOURCE_FACT  vendor/loader/src/internal.ts:117-133  the loader shape is decided by
             which module-job API exists, never by Node version (v2 landed in
             24.12.0, so a major-version test mistags 24.0-24.11.1 as v2 and
             reverses resolveSync's parameters). The probe reads the version TAG,
             which is what DSH's own HMR service switches on
             (packages/boot/hmr/src/index.ts:189-193).
SOURCE_FACT  vendor/loader/src/config/tree.ts:118-121  a `cordis:` specifier is
             short-circuited to ctx.loader.builtins and has NO FILE.
```

**Why a dump is not a graph, and this is the motivating measurement.** The
superseded `resolved_plugin_graph_digest` was the sha256 of
`qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml`, and:

1. **no tool checked it.** `grep -c resolved_plugin_graph_digest
   helpers/rederive-identity.py helpers/doctor.py` → `0` and `0`.
2. **its basis asserts the defect CMP-02 exists to catch.** The digest matches its
   file (`23f763d1…`, re-measured), and that file still reads
   `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'` at lines 112-116
   — the **confining** mode — while the tree resolves `danger-full-access`. So an
   identity input certified a graph in which the deployment was confined.
3. **a dump is what the loader DECLARED; the graph is what it ACTIVATED.** Different
   facts, and the difference is exactly what this project has recorded twelve times.

The old value is **carried in the manifest beside the fresh one** with its stale
reason, rather than deleted: it is now a RECORD and can certify nothing, and the
supersession stays auditable.

---

## 4. GRAPH-REALPATH — 8/8 CONTROLS, INCLUDING THE POSITIVE ONE

`qualification/runners/p14-graph-realpath-controls.py`, artifact
`qualification/results/P14-manifest/graph-realpath-controls.json`. Each case mutates
the **observation in memory** — never the tree, since a control arm that mutated the
tree would be the defect class the gate is about.

| case | injection | required | observed |
|---|---|---|---|
| **POSITIVE** | the real observation | 0 | **0** |
| SIBLING | one row → a sibling worktree | 1 | **1** (names `wt-s99`) |
| MAIN | one row → the main tree | 1 | **1** |
| BACKSLASH | the sibling case, `\` spelling | 1 | **1** |
| UNRESOLVED | one row's realpath nulled | 1 | **1** |
| MISSING | a resolved module not on disk | 1 | **1** |
| NO-TREE | `repo_root` removed | 1 | **1** |
| NO-EXT | extension rows removed | 1 | **1** |

`verdict: CONTROLS_PROVED (8/8)`. The POSITIVE case is what makes the others mean
something: a gate that is red on everything is not a gate either.

**This covers the RUNTIME plane, which no existing gate did.**
`packages/dsh-daily-work/src/cross-tree-paths.test.ts` refuses a source-plane
**literal**. It cannot see what `dsh-daily-work/host` **resolves to**, because that
depends on the profile's `node_modules` links, which `helpers/new-writer.ps1`
rewrites per writer. With fifteen worktrees live, a boot whose links point at a
sibling loads the **sibling's implementation** while reporting its own composition,
and every source-plane gate stays green. That is the shape that forced G-SEAM-29 and
G-SEAM-36 to be retracted.

**And the controls file itself obeys the rule it tests.** My first version hardcoded
the foreign literals; `cross-tree-paths.test.ts` would have gone RED on it,
correctly. They are now derived from the file's own repo root by substituting the
last segment, so they have the refused **shape** at run time while no literal of that
shape is in the source — and they are correct in every worktree, not only `wt-p14`.

```
TEST_RESULT  node node_modules/vitest/vitest.mjs run src/cross-tree-paths.test.ts
             -> 7 passed / 0 failed, with every new file of this slice in the tree
```

---

## 4b. ID-FRESH — 8/8 CONTROLS, AND ONE FOUND A REAL BUG IN MY OWN CONSUMER

V5 §18: *"current runtime graph/build differs -> old identity rejected."* Computing
two identities is not the same as rejecting a stale one: without a consumer, an old
identity is a string that happens to differ from a new one and nothing in the release
path notices. That is this project's most-recorded defect, so the consumer is written
(`build-manifest.py --id-fresh-check OLD NEW`) rather than assumed to arrive later.

`qualification/results/P14-manifest/id-fresh-controls.json`, 8/8. Each case mutates a
manifest **in memory** and **recomputes the identity over the mutated `build`** with
the generator's own algorithm, so each case is a manifest a real build could produce.
Two arms are load-bearing in opposite directions:

| case | injection | required | observed |
|---|---|---|---|
| **POSITIVE** | the manifest against itself | 0 | **0** |
| **QUALIFIER** | only the dirty path count moved | 0 | **0** |
| COMMIT | only commit + tree moved | 1 | **1**, says `COMMIT MOVED ONLY` |
| GRAPH | one row's realpath → sibling worktree | 1 | **1**, names `resolved_plugin_graph` |
| CATALOG | one tool removed from the catalog | 1 | **1**, names `model_tool_catalog` |
| PROFILE | the profile digest changed | 1 | **1**, names `profile` |
| CONTRACT | only the contract identity moved | 1 | **1**, says `CONTRACT MOVED ONLY` |
| NO-IDENTITY | a manifest that never computed one | 1 | **1**, refused not compared |

**QUALIFIER is the arm that keeps the gate usable**: a concurrent writer's untracked
file must NOT be reported as a changed deployment, or the gate fires on noise and is
ignored within a day.

**The CONTRACT control found a real bug in my own consumer.** It expected exit 1 and
observed **0**. I had reasoned *"the deployment did not change, so nothing is stale"*.
But result and evidence files **bind to `QualificationContractIdentity`**, so a contract
move invalidates every filed result exactly as a runtime move does — the difference is
**why** and therefore **what to do**, not **whether** to reject. Fixed. A control that
found nothing would have been the suspicious outcome.

The two causes are reported separately because they call for different actions, and a
single combined hash cannot distinguish them:

```
RUNTIME moved  -> the DEPLOYMENT changed   -> RE-MEASURE
CONTRACT moved -> the deployment is unchanged -> RE-QUALIFY the contract
```

and the changed **fields** are named, so a commit-moved-only state (the normal state at
a writer's tip) is visibly different from an artifact move rather than triggering a
needless re-boot.

---

## 5. THE GENERATOR REFUSES RATHER THAN DEFAULTS — EXERCISED FOR REAL, TWICE

A **load-bearing gap** sets `identity_computable: false` and **no identity is emitted
at all**, so a partial manifest cannot be mistaken for a complete one. This was not
a design intention I wrote and left untested; it fired twice while building this:

**Refusal 1 — a missing file, correctly detected and wrongly concluded.** I looked
for `packages/dsh-ipython/src/bridge_client.py`, did not find it, and recorded a gap.
The gap was the right response; the conclusion was wrong. The bridge client is **not
a file** — it is `PYTHON_CLIENT_SOURCE`, a template literal in
`bridge.ts:1325`, written to the kernel's client path by `BridgeServer.deliver`
(`bridge.ts:944-945`) and compiled by the kernel with `exec(compile(...))`
(`bridge.ts:1291-1292`).

**Refusal 2 — a parser reading the wrong boundary.** Having found the literal, I
hashed it with a regex and got **74 characters**. The client is 340 lines. The
literal contains **escaped backticks** (its own docstring reads
`` \`dsh.call(name, args)\` ``), so the non-greedy match stopped at the first escape
sequence — and the manifest would have hashed 74 characters of a 12 KB client while
looking like a successful measurement. That is this project's most-recorded defect: a
parser that reads the wrong boundary and reports a confident wrong answer.

**The fix is not a better regex.** Node imports the built module and hashes the
**value of the export**, so JS escape rules are not re-implemented in Python.
Measured: `11975 chars, 340 lines, first_line "…DSH native-tool bridge client…",
last_line "tools = _ToolNamespace(_channel)"`. And hashing the built `lib/bridge.js`
rather than `bridge.ts` is the stronger claim: a change to the TypeScript *around*
the literal does not move a byte the kernel executes.

---

## 6. DEFECTS FOUND IN MY OWN WORK BY RUNNING IT

Recorded because they are the shape this project keeps paying for.

1. **The generator read the commit at GENERATION time.** The observation was taken
   at `c281f12`, one commit landed, and the regenerated manifest reported `c061e09`
   — claiming to describe a build it was never measured against, with nothing in the
   artifact to show anything had moved. That is the self-referential-identity defect
   one layer down. Fixed: the driver reads the revision at **observation** time, the
   manifest keeps it, and the live values are reported **beside** it as a divergence.
2. **The dirty path count was hashed** — see §1.
3. **`--check-expected` measured pnpm with the GLOBAL shim** (`11.24.0`) and failed
   the requirement of exactly `11.7.0`. Gate A02 already recorded the correct
   distinction: *"corepack pinned pnpm 11.7.0; the global 11.24.0 was not used."* The
   pinned upstream declares `packageManager: pnpm@11.7.0`, so the deployment's pnpm
   is the corepack-resolved one. The requirement is now checked against
   `corepack pnpm`, and the global value is reported beside it. A checker that failed
   on the global shim would be reporting a fact about the operator's PATH as if it
   were a fact about the deployment — the same class as measuring the wrong tree.
4. **`--check-expected` read family prefixes from `cases[].family`**, which holds the
   family **NAME** (`"IDENTITY"`), and reported 11 spurious mismatches. Read from
   `families[].prefix` now, where the definition declares them; the names are checked
   separately so a family whose prefix stayed and whose subject changed is visible.
5. **A bare `subprocess.run(["pnpm", ...])` crashed with `FileNotFoundError
   [WinError 2]`** on Windows, because `shutil.which` resolves to `pnpm.cmd` and
   Python cannot execute a `.cmd` directly. A tool that cannot run must report exit 2
   and say why, never traceback.
6. **`cordis:include` failed to resolve** and the driver's "every row resolved" check
   went RED. The check was right to fire; the row is a loader builtin with no file by
   construction. Classified by the loader's **own prefix rule** rather than by an
   exception list, and the check is now `resolved + builtin == rows` — so it still
   cannot distinguish a builtin from a package that **failed** to resolve, which the
   alternative ("at most N unresolved") would have broken.

---

## 7. THE UNCHECKED-INPUT HOLE, CLOSED

`qualification/results/ROOT-round2/identity-input-unchecked-and-stale.md` recorded
that `resolved_plugin_graph_digest` was checked by no tool. Both
`helpers/rederive-identity.py` and `helpers/doctor.py` check it now, and both say
plainly that **matching is not current**:

```
the input NO tool used to check -- resolved_plugin_graph_digest:
  basis            qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml
  matches its file True
  BUT MATCHING IS NOT CURRENT. That dump predates F3 and its sandbox-policy
  row still reads `mode: workspace-write` -- the CONFINING mode CMP-02 exists
  to catch -- while this tree resolves `danger-full-access`.
```

It is deliberately **not** folded into the recomputed identity: the fresh graph is a
runtime observation and cannot be recomputed from a file, and substituting the dump's
own digest would make the identity certify a dump again.

---

## 8. `compatibility.lock.json` WAS NOT EDITED

The task said to say so first if my design required it. **It did not.** The lock's
`deployment.identity` is now a superseded RECORD; the doctor reports a moved pin as
a **note** rather than a failure, and 84 PASS rows in `qualification/gates.json` still
cite the old value as the identity they were measured under — which is correct and
must not be re-stamped.

I did **not** touch `build-gates.py`, which is the thing that would re-stamp them.
That re-stamping is a real defect (running it today would write the CURRENT identity
onto all 84 historical PASS rows) and it is **owned elsewhere**; it is reported here
rather than fixed, because the fix belongs to whoever owns the gate generator and a
second writer editing it concurrently is how a fix gets dropped.

---

## 9. COMMANDS AND RESULTS

```
TEST_RESULT  python qualification/runners/build-manifest.py --check-expected
             -> 8 requirements hold; exit 1 for ONE real violation (see §10)
TEST_RESULT  node qualification/runners/run-p14-manifest.mjs
             -> 18/18 checks ok, verdict OBSERVED
TEST_RESULT  python qualification/runners/build-manifest.py --from-observation ... 
             -> identity_computable True, 0 gaps, exit 0
TEST_RESULT  python qualification/runners/p14-graph-realpath-controls.py
             -> CONTROLS_PROVED (8/8)
TEST_RESULT  python qualification/runners/p14-id-fresh-controls.py
             -> CONTROLS_PROVED (8/8)
TEST_RESULT  node node_modules/vitest/vitest.mjs run src/cross-tree-paths.test.ts
             -> 7 passed / 0 failed
TEST_RESULT  python helpers/doctor.py           -> exit 1 (the one requirement violation)
TEST_RESULT  python helpers/doctor.py --identity-only  -> exit 0
TEST_RESULT  python helpers/rederive-identity.py        -> exit 0, reports the supersession
TEST_RESULT  determinism: two generations of the same observation, with a volatile
             untracked file created between them -> SAME identity, byte-identical manifest
```

---

## 10. PASS / FAIL / BLOCKED / NOT_RUN

| item | status | reason |
|---|---|---|
| `compatibility.expected.json` exists and holds requirements only | **PASS** | self-reference audit: 1 sha256, allowlisted |
| `BuildManifest` generated with every V5 §14 field | **PASS** | `identity_computable: true`, 0 gaps |
| Runtime + Contract identities computed | **PASS** | `c969808e…` / `a091cb59…` |
| Graph freshly observed with realpaths | **PASS** | 177 rows, 176 realpaths + 1 builtin, 0 unresolved |
| Model tool catalog/schema/order | **PASS** | 27 names, header order + schema + order digests |
| GRAPH-REALPATH refuses a foreign tree | **PASS** | 8/8 controls, incl. the positive one |
| ID-FRESH: a changed build's old identity is rejected | **PASS** | consumer written + 8/8 controls; found a real bug in my own consumer (§4b) |
| `helpers/rederive-identity.py`, `helpers/doctor.py` updated | **PASS** | both check the previously-unchecked input |
| `compatibility.lock.json` | **NOT TOUCHED** | not required by the design |
| the pinned checkout is clean (ID-06 requirement) | **FAIL** | one tracked file modified — see below |
| Node range actually evaluated | **NOT_RUN** | no semver implementation is vendored; both values are reported and the checker says the range was not evaluated |
| `build-gates.py` re-stamping of 84 historical PASS rows | **NOT FIXED** | owned elsewhere; reported, not silently patched |

**The one live requirement violation, and it is not mine:**

```
$ python qualification/runners/build-manifest.py --check-expected
  - the pinned checkout is DIRTY: 1 tracked path(s) modified
    (["M packages/deliverables/workspace-changes/src/index.ts"]).
    ID-06's oracle requires a clean working tree.
```

Already diagnosed by root in `qualification/results/ROOT-round2/ID-06-crlf-artifact-diagnosis.md`:
`git diff --numstat` is empty and `git hash-object --path=` equals HEAD's blob, so it
is a line-ending artifact rather than a content change; mtime `2026-09-19 19:19:47`,
the day **before** this wave. My checker reports it because ID-06's oracle is about
`git status --porcelain`, not about whether the cause is benign.

---

## 11. UNRESOLVED UNKNOWNs

1. **Nothing in the release path CALLS `--id-fresh-check` yet.** The consumer exists,
   is exercised by 8 controls, and found a real bug — but wiring it into
   `RELEASE_DECISION.json` / CI is a later step, and until then ID-FRESH is a gate
   that must be run by hand.
2. **`resolved default` values are not in the manifest.** The probe reads
   `options.config` — what the loader was GIVEN, with `!!js` expressions as
   `{__jsExpr: ...}` — not the schema-resolved config, which is applied at plugin
   construction and is not reachable without touching the plugin instance. So
   `tools.mode` appears as `{__jsExpr: "process.env.DSH_TOOLS_MODE"}`, and the
   presentation mode is **derived from a negative observation** instead. A reader
   must not read a missing key as "no value".
3. **The Node requirement range is not evaluated.** Reported, not checked.
4. **`acceptance_spec_sha256` was dropped** (it pinned the retired 112-case
   `acceptance-spec.json`). The decision is recorded in
   `lineage_of_deployment_inputs.dropped_with_reason`, but whether any consumer needs
   it is not established.
5. **Whether any consumer treats the old `resolved_plugin_graph_digest` as
   load-bearing** was not audited beyond `qualification-identity.py` reusing it
   verbatim. That note was in the original finding and I did not extend it.
6. **The Python floor (`>=3.10`) is derived from nothing in the code** and is named
   as the weakest requirement in the file. What actually certifies the Python is the
   environment manifest digest.
7. **The manifest is stale by construction after the commit that adds it** — the
   commit moves the tree, so the recorded `project_git_commit` no longer names HEAD.
   This is intended (the same property `qualification-identity.py`'s staleness report
   documents for v2 results) and the divergence is reported, but it means the filed
   manifest is a statement about `c061e09` and not about whatever HEAD is when you
   read this.
8. **One observation, one boot.** The graph and catalog were observed once. No
   repeat-boot stability measurement was taken for THIS probe (the 1-in-4 variance
   this project recorded was on `r5-restart-epoch.test.ts`, a different arm).

---

## 12. CLAIMS I AM NOT MAKING

1. **A manifest describing a build does not prove the build is correct.** It proves
   the artifacts, graph, catalog and environment are identified, and that they are
   the ones observed. Nothing here says the deployment works, and no gate verdict
   follows from it.
2. **Any value I could not obtain is a NAMED GAP, not a filled-in default.** That is
   why `identity_computable` exists: a load-bearing gap produces NO identity rather
   than a weaker one. It fired twice for real during this slice (§5).
3. **The two identities are not yet used by any release decision.** They are
   computed, reproducible, and refusal-tested (both gates 8/8), and the ID-FRESH
   consumer exists — but nothing in `RELEASE_DECISION.json` or CI calls it yet, so
   until that wiring lands the gates must be run by hand.
4. **GRAPH-REALPATH's 8 controls exercise the GATE, not a real foreign boot.** Every
   case mutates an observation. I did not boot from a sibling worktree and watch the
   gate go red on a genuine cross-tree resolution — the mechanism is proven to
   detect it, the scenario is not reproduced end to end.
5. **"The graph is freshly observed" is a claim about ONE boot.** It is not a
   stability claim, and I did not measure boot-to-boot variance for this probe.
6. **`compatibility.expected.json` being unmovable is a claim about DIGESTS, checked
   by walking the file.** It says no sha256 of a repo file is in there. It does not
   say the requirements are the RIGHT requirements — several are transcribed from
   prose, and §11.6 names the weakest.
7. **I did not run the full test suite, by instruction.** One test file was run
   (`cross-tree-paths.test.ts`), chosen because my new files live in the plane it
   scans. The rest of the suite was not run against these changes.
8. **The manifest does not prove the absence of a foreign path in code the boot
   never loaded.** It proves every row the loader ACTIVATED resolved inside this
   tree. A module reached only by a dynamic import at request time is outside what
   any boot-time observation can see — which is the same limit `homelock.ts:126`
   demonstrates from the other direction.
