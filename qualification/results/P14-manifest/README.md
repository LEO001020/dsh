# P14 — the manifest plane, and how to re-run it

## What is here

| path | what it is |
|---|---|
| `STEP1-SOURCE-MAP.md` | the source map of the self-referential identity, written and committed BEFORE the fix |
| `FINDINGS.md` | the full slice report: the split, a real manifest, the controls, what is NOT claimed |
| `observation.json` | the fresh runtime observation (a live boot of the built candidate) |
| `transcript.txt` | that boot's driver transcript |
| `graph-realpath-controls.json` | GRAPH-REALPATH controls, 8/8 |
| `id-fresh-controls.json` | ID-FRESH controls, 8/8 |
| `p14-manifest.patch.yml` | the MATERIALISED overlay, naming this tree's probe (generated) |

The manifest itself is filed under its contract identity:
`qualification/results/trusted-local-v3.<contract-id>/build-manifest.json`.

## How to re-run it

```sh
# 1. requirements only (no boot needed)
python qualification/runners/build-manifest.py --check-expected

# 2. observe the runtime (boots the built launcher; ~40s)
node qualification/runners/run-p14-manifest.mjs

# 3. compute the identities from that observation (reproducible, no boot)
python qualification/runners/build-manifest.py --from-observation \
    qualification/results/P14-manifest/observation.json
python qualification/runners/build-manifest.py --from-observation \
    qualification/results/P14-manifest/observation.json --write

# 4. the two V5 section 18 gates
python qualification/runners/build-manifest.py --graph-realpath-check \
    qualification/results/P14-manifest/observation.json
python qualification/runners/build-manifest.py --id-fresh-check <old> <new>

# 5. the controls that prove both gates FIRE
python qualification/runners/p14-graph-realpath-controls.py
python qualification/runners/p14-id-fresh-controls.py

# 6. the deployment metadata check (requirements + the superseded identity)
python helpers/doctor.py
```

Step 3 needs no boot, which is what makes the identity reproducible by a third
party who has the observation and not this machine's runtime.

## Why there may be TWO `trusted-local-v3.*` directories, and why that is correct

Both were generated from the SAME observation, minutes apart. Their
`RuntimeDeploymentIdentity` is **identical** and their
`QualificationContractIdentity` **differs** — because the generator itself
(`build-manifest.py`) is a contract runner, and it was edited between them.

That pair is the clearest available demonstration that the split discriminates
what a single combined hash could not:

```
RuntimeDeploymentIdentity      c969808e7633162526b3a93d7ea398ce2e63b0e9a10fac13e3f42fad257d65de   (both)
QualificationContractIdentity  a091cb5949029fa709e67aa2cfa5767e3346e5150f055636800fab626f10f442   (first)
                               5146ee996bea2de8500e029ea509cf466bbb263dae2155d0e73913ef37fe2342   (second)
```

```
$ python qualification/runners/build-manifest.py --id-fresh-check <first> <second>
ID-FRESH: 1 problem(s) -- the old identity must NOT be reused.
  ... while the RuntimeDeploymentIdentity did NOT.
  STALE, CONTRACT MOVED ONLY: the deployment is unchanged and the contract moved.
  Filed results bind to the contract identity, so they are stale.
  RE-QUALIFY the contract; NO re-measurement of the deployment is needed.
```

A reader of the first directory learns *"the deployment is the same, the contract
moved"* and does not re-boot. A single combined hash would have said only *"stale"*.

## The two identities are BOUND TO A COMMIT, not to "now"

Twelve writers edit this tree concurrently, so the commit moves under any
measurement. The driver reads the revision at **observation** time and the manifest
keeps it:

```
build.project_git_commit          the commit the observation was taken at
build.project_git_bound_to        a sentence saying so
qualifiers.git_live_at_generation the live values, and whether the commit moved
qualifiers.artifact_staleness     whether any HASHED artifact moved
```

Read `qualifiers.artifact_staleness` before concluding anything from a commit move:
`COMMIT MOVED ONLY` means every hashed artifact is byte-identical and the previous
measurements still describe the deployment; an entry under
`moved_since_observation` means re-measure.
