# An identity input that NO gate checks, and whose basis is a stale dump

Found by writer S3 (reported as its one unresolved unknown); independently
re-measured here. It is recorded separately because it is a hole in the identity
mechanism itself rather than a stale value.

## The input

`compatibility.lock.json` → `deployment.inputs.resolved_plugin_graph_digest`
= `23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b`

## Hole 1: nothing verifies it

```
$ grep -c resolved_plugin_graph_digest helpers/rederive-identity.py helpers/doctor.py
helpers/rederive-identity.py:0
helpers/doctor.py:0
```

The tool that RE-DERIVES the identity does not check it, and the tool that
VALIDATES the lock does not check it. So a stale value here is invisible to both
gates. This is the same defect class as everything else in this project — a
declared mechanism with no caller — one layer down, in the identity machinery that
is supposed to be the ground truth.

## Hole 2: the value is correct for its file, and its file is wrong for the tree

The digest DOES match the artifact it names:

```
$ cat qualification/results/M3.1-c2-profile/dump-sha256.txt
23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b *.../dump-config-daily-candidate.yml
$ sha256sum qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml
23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b
```

So the pin is not corrupt. But that dump is from **`786edb1`, 2026-09-19** — before
F3, before F1, before the whole round-1 remediation. Re-generating the dump from
the current tree and diffing row by row:

```
M3.1 rows: 164 | fresh rows: 174
only in M3.1 : []
only in fresh : daily-data-plane, daily-history, daily-no-sandbox-contract,
                daily-programmatic-scope, daily-web-search,
                daily-work-tool-protocol-guards, daily-writers,
                fs-local, ipython-kernel-host, pwsh-local
changed bodies: 8
  agent-presets, approval, daily-work-host, fs-sandbox, permission,
  pwsh-sandbox, sandbox-policy, ui-permission
```

**10 rows added, 8 changed, 0 removed.** The added rows are R6's data plane, R7's
store, R1's contract guard and the `fs-local`/`pwsh-local` substitutions. The
changed bodies are exactly the rows R1 and R4 touched.

## The sharpest single fact

The dump the identity is bound to still contains the F3 defect:

```
--- M3.1 (the identity's basis) ---
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'

--- FRESH (the current tree) ---
- id: sandbox-policy
  config:
    mode: danger-full-access
```

So `resolved_plugin_graph_digest` currently certifies a graph in which the
deployment resolves to the **confining** mode that CMP-02 exists to catch. An
identity input that hashes a pre-fix graph is worse than an unchecked one: it is
unchecked AND it asserts the defect is present.

## Why this is NOT a reason to stop

The identity is still meaningful for the inputs that ARE checked — `host_profile_digest`
and `agent_preset_digest` both moved correctly and were adopted with per-input
verdicts (S3's work). This note is about the one input that is neither checked nor
current, and the honest consequence is narrow: **the deployment identity is
weaker than its name claims, by exactly one input.**

## What would fix it

A new dump artifact generated from the current tree, with its own evidence, and a
check added to `rederive-identity.py` so the input cannot silently rot again. S3
correctly declined to manufacture the artifact — a dump invented to make a pin
agree is the "change the thing measured" failure this project forbids. It needs its
own measurement and its own record, which is a later slice.

## Not established here

Whether any CONSUMER of the identity treats `resolved_plugin_graph_digest` as
load-bearing. S3 read `qualification-identity.py` and found it reuses the value
verbatim from the lock rather than recomputing it, which means it propagates rather
than validates. A full consumer audit was not done.
