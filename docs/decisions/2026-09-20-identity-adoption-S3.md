# DECISION: adopt the re-derived deployment identity `533c8cb0…`, with a per-input verdict

- **Date**: 2026-09-20 (round 2, wave 2)
- **Writer**: S3, worktree `D:\DSH\work\wt-s3`, branch `wt/s3`
- **Decision**: ADOPT. Both moved inputs are INTENDED changes, not defects.
- **Supersedes**: `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
- **Adopts**: `533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb`
- **Files changed by this decision**: `compatibility.lock.json` only.
  Supporting evidence in `qualification/results/S3-identity/`.

---

## 1. The question this record answers

`helpers/rederive-identity.py` recomputes the identity, shows which file-derived inputs
moved, and **refuses to write the lock**. Its own output states the reason:

> A MOVE IS NOT AUTOMATICALLY A CORRECTION. Two of this project's six re-derivations
> were fixes for real defects (a Windows path mangled by Python escape processing; a
> missing drive-letter strip on the preset root). Decide for EACH move whether it is an
> intended change or a defect, and record which.

So the deliverable of this slice is not the new hash. The hash is arithmetic. The
deliverable is a **per-input verdict with the evidence behind it**, and this record is
where the verdicts live.

## 2. What was reproduced, not trusted

The assignment supplied the tool's output. It was re-run on this worktree and matched
exactly — same recorded identity, same recomputed identity, same two moved inputs, same
prefixes. `qualification/results/S3-identity/rederive-output.txt` holds both the BEFORE
and the AFTER runs.

The new identity was then computed a **second time, independently**, straight from the
lock's declared algorithm over the corrected inputs, and matched. This is deliberate: a
value copied out of the tool's stdout would make the lock agree with the tool even if
the tool were wrong. It agrees with the arithmetic.

## 3. The per-input verdicts

### `host_profile_digest`: `5b8b2a8e…` -> `0e8e370e…` — **INTENDED**

**File**: `profiles/daily-candidate/cordis.patch.yml`

**The pin was correct when written.** `git log -S "5b8b2a8e…" --all -- compatibility.lock.json`
returns exactly one commit, `c3b9dba`, and `git show c3b9dba:<file>` hashes to
`5b8b2a8e…`. So this is drift, not a bad pin.

**The specific diff that moved the digest.** Across `c3b9dba..HEAD` the file gained
**135 lines: 130 comments, 1 blank, and 4 executable lines.** The 4 executable lines
are exactly one row:

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
```

added by `e465a31` ("F3: make the trusted-local composition TRUE, not merely
documented", R1, V3 F3 / CMP-02). That commit's message states the defect it closes:
the deployment declares trusted-local with the OS user account as the authority
boundary while the effective sandbox mode was `workspace-write`, a confining mode, and
it measured that this was not narration alone because `ptc-runtime-node` confines
unless the mode is exactly `danger-full-access`.

The other three commits are comment-only and say so themselves: `5bcf546` (the V3 F1
`approval` consumer inventory), `d50b2bb` (eliding a real absolute workspace path from
a comment that quoted a boot narration — `upg-gates` was right to fail it), and
`73747a4` (R1's startup-boundary loudness work, which records that the digest moved
again for a comment-only reason).

**Corroborated at runtime**: a fresh `--dump-config` on this tree shows
`sandbox-policy.mode: danger-full-access` where the pre-F3 dump shows
`!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`.

### `agent_preset_digest`: `16bc20e5…` -> `05f7a029…` — **INTENDED**

**File**: `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`

**The pin was correct when written.** The same `git log -S` returns exactly `c3b9dba`,
and `git show c3b9dba:<file>` hashes to `16bc20e5…`.

**The specific diff that moved the digest.** Exactly ONE commit touches the file since
the pin — `1ea7e89` ("R4: give WorkService runs a real human authorization path (F1 /
G-SEAM-31)"), which is the commit the assignment named as the likely cause. Confirmed.
The file gained **17 lines: 14 comments, 1 blank, and 2 executable lines**, exactly one
row:

```yaml
- id: daily-work-command
  name: dsh-daily-work/command
```

That commit's message states the defect: `WorkService.createRun` had exactly one
non-test caller, in no production import graph, so the model's work tool refused with
`this session has no active run` and the mandatory N=10 rolling top-up could not be
exercised by any user action. The row is deliberately in the AGENT PRESET rather than
the profile patch because `ctx.commands` layers are keyed by the Agent object — the
same trap this file already documents for `ctx.tools`.

`git show 1ea7e89:<file>` hashes to `05f7a029…`, identical to the working tree, and
`1ea7e89` is an ancestor of HEAD, so this one commit accounts for the whole move.

**The row resolves to something real**: `packages/dsh-daily-work/package.json` exports
`./command` -> `./lib/command-work.js`, and both the source and the built file exist. A
row whose package subpath did not exist would be the "declared but unreachable" defect
this project has recorded a dozen times.

## 4. What an accidental move would have looked like, and what was measured

Both files were tested for every accident signature this project has actually recorded.
Every check is negative, and the checks are listed so the verdict is falsifiable rather
than asserted:

| accident signature | `cordis.patch.yml` | `agent.cordis.yml` |
|---|---|---|
| a line-ending change moved the digest | CRLF count 0 | CRLF count 0 |
| a BOM was added | no BOM | no BOM |
| an executable line was DELETED | 0 removed lines (pure addition) | 0 removed lines (pure addition) |
| a row id was duplicated | no duplicates | no duplicates |
| a machine-specific path leaked in | 0 matches in added lines | 0 matches |
| a secret leaked in | 0 matches | 0 matches |
| tab indentation / trailing whitespace | 0 / 0 | 0 / 0 |
| an unintended file was touched | every commit names its own defect | one commit, names its defect |

The one commit that removes a line is `d50b2bb`, and it removes a COMMENT line
containing a real workspace path, replacing it with an elided one. That is a
correction, and it is the opposite of an accident.

## 5. The consequence, stated plainly

`0a0996f3…` is now the SUPERSEDED identity. Per this project's own rule, applied by the
tool that produced the numbers:

> EVERY VERDICT BOUND TO THE OLD IDENTITY IS NOW STALE.

Measured blast radius — **65 files / 860 lines / 868 occurrences** at `HEAD`, excluding
`node_modules`:

- **`qualification/specs/acceptance-spec.trusted-local-v1.json`**: 314 of 317 evidence
  entries name the old identity; 107 of 109 cases carry at least one; 94 PASS and
  13 FAIL. `verify-spec.py` goes from 3 problems to 317 (314 of them this move; the
  other 3 are the pre-existing line-ending issue on `CMP-07`, `CMP-12`, `VER-09`).
- **`qualification/results/trusted-local-v2-identity/evidence-reuse.json`**: the E3
  reuse decision goes from **2 eligible (`CMP-08`, `CMP-14`) to 0 eligible**, refused
  with `E3.1: the evidence names identity/identities ['0a0996f3944b5528'] but the
  lock's is 533c8cb08b2ccd7f`.
- **All ten family `GATES.md` files** (V1..V10) plus the nine `VER-0x` verdict files.
- **Nine runner/script files** that name the old identity in code — the highest-priority
  re-runs, because a hardcoded identity will file its next result under a stale value.

**These files are NOT rewritten.** They are historical evidence for a superseded
identity. Re-labelling them would be the inheritance the trusted-local spec forbids.
The full list and the re-run each needs is in
`qualification/results/S3-identity/blast-radius.md`.

## 6. Two inputs the tool does NOT check

- **`acceptance_spec_sha256`**: IS covered by the tool, reported no move, and verified
  against disk by hand. UNMOVED. Covered by `doctor.py` as well.
- **`resolved_plugin_graph_digest`**: **NOT covered by `rederive-identity.py` and NOT
  covered by `doctor.py`.** Measured by hand: it still equals the sha256 of the dump
  file it names, so it was left UNMOVED. But that dump is from `786edb1` (M3.1,
  2026-09-19) and no longer describes this composition — a fresh dump differs in 18
  rows, including `sandbox-policy.mode` and the absence of `daily-work-command`. The
  field is not wrong about its file; it is a weaker input than its name claims. Left
  for a writer who can produce a new dump with its own evidence.

## 7. What this decision does NOT claim

- It does **not** claim the new identity is a QUALIFIED deployment. Promotion stays
  `NOT_READY`.
- It does **not** claim any of the 109 cases is now PASS. The tally is unchanged
  (95 PASS / 13 FAIL / 1 BLOCKED_EXTERNAL) because no verdict was touched — but every
  one of those verdicts is now stale as evidence for the new identity.
- It does **not** claim the two moved inputs are the ONLY things that changed in the
  tree. It claims they are the only two the identity covers that moved.
- It does **not** claim `resolved_plugin_graph_digest` is correct. It claims it is
  unmoved and unchecked.
