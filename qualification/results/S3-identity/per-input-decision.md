# S3: the per-input decision. One verdict per moved input, from the diff, not from assumption.

`helpers/rederive-identity.py` refuses to write the lock and says why:

> A MOVE IS NOT AUTOMATICALLY A CORRECTION. Two of this project's six re-derivations
> were fixes for real defects ... Decide for EACH move whether it is an intended
> change or a defect, and record which.

This file records that decision, per input, with the measurement behind it.

## The two methods used, and why both

1. **Structural**: classify every added line as comment / blank / EXECUTABLE, and
   check the additions for the accident signatures (removed lines, CRLF, BOM, tab
   indentation, trailing whitespace, duplicated row ids, absolute machine paths,
   secret-looking tokens).
2. **Causal**: `git log -S "<old digest>" --all -- compatibility.lock.json` to find
   the commit that pinned the old value, then `git log -p` over the file from that
   commit to HEAD, reading each commit message against the diff it produced.

Structural alone would say "it changed, and nothing looks broken". Causal alone would
say "a commit intended this". A defect is exactly a change that a commit intended but
that was not the change the commit describes, so both are needed.

---

## INPUT 1 of 2 — `host_profile_digest`

```
recorded 5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4
computed 0e8e370e06375ad4a289fa36f783232dde4159a69844422d6363b874af7445f2
file     profiles/daily-candidate/cordis.patch.yml
```

### Where the old value came from

`git log -S "5b8b2a8e…" --all -- compatibility.lock.json` returns exactly one commit:
`c3b9dba` ("re-derive the deployment identity: THREE inputs had gone stale, not one").
`git show c3b9dba:profiles/daily-candidate/cordis.patch.yml` hashes to `5b8b2a8e…`.
The pin was correct when written.

### What changed, as a diff

Commits touching the file since the pin: `e465a31`, `5bcf546`, `d50b2bb`, `73747a4`.

**`e465a31` — "F3: make the trusted-local composition TRUE, not merely documented" (R1, V3 F3 / CMP-02).**

The commit message states the defect: the deployment declares trusted-local with the
OS user account as the authority boundary, while the effective sandbox mode was
`workspace-write`, a CONFINING mode; and it measured that this was not narration only,
because `ptc-runtime-node` confines unless the mode is exactly `danger-full-access`.

Its diff adds 80 lines to the profile. The executable part is one row:

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
```

The remaining 76 lines are the comment block explaining why both keys are restated
(a patch REPLACES the whole `config` object, so stating only `mode` would drop
`workspaceRoot`, whose schema has no default).

**`5bcf546` — "F3: record the `approval` consumer inventory V3 F1 asks for".**
Its own message says "no executable change, and the profile's composed digest
therefore does not move (verified: the diff is comment-only)". The diff is 50
insertions, all comments.

**`d50b2bb` — the merge repair pass.** One hunk: a comment in the profile quoted a
real boot narration that embedded an absolute workspace path
(`"D:/DSH/work/wt-r1"`), and `upg-gates` was right to fail it. The path is replaced
with `<the session workspace>` inside the comment, with the verbatim string left in
R1's artifact. Comment-only, 6 insertions / 1 deletion. Note this is the one commit
that REMOVES a line — and it removes a comment line, replacing it with another.

**`73747a4` — "R1's F3 follow-up -- the startup boundary was SILENT, and is now LOUD".**
50 insertions, all comments (the `approval` inventory). Its own message records that
the profile digest moved again for this comment-only reason.

### The structural measurement, c3b9dba -> HEAD

```
added=135  blank=1  comment=130  EXECUTABLE=4
  EXE: '- id: sandbox-policy'
  EXE: '  config:'
  EXE: '    mode: danger-full-access'
  EXE: '    workspaceRoot: !!js process.cwd()'
removed lines            : 0   (pure addition)
CRLF                     : 0
BOM                      : False
tab-indented lines       : 0
trailing-whitespace lines: 0
absolute machine paths in added lines : 0
secret-looking tokens in added lines  : 0
duplicated row ids       : none
```

The 4 executable lines are exactly the `sandbox-policy` row above. The other 131
added lines are 130 comments and 1 blank.

### VERDICT: INTENDED. Not a defect.

The one executable change is the fix for the defect the commit names, and it is the
change the commit says it is. It is not an accident by any signature this project has
recorded: no line-ending change, no unintended file, no removed executable line, no
duplicated row id, no machine path, no secret. It is corroborated at runtime: a fresh
`--dump-config` on this tree now shows `mode: danger-full-access` for the
`sandbox-policy` row where the pre-F3 dump shows
`mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`.

The comment-only portion is not incidental: those comments are the V3 F1 `approval`
consumer inventory, which the audit asks for as a disposition rather than an
inventory. So the digest also moved for documented reasons that are part of the same
deliverable.

---

## INPUT 2 of 2 — `agent_preset_digest`

```
recorded 16bc20e559d0c05b810876522fd468952b421a69ed2b5276a3ddd06c01053bce
computed 05f7a029739692db4245efad803e6bbbec7caf309b2ac7bb2dd57b97f764a19c
file     profiles/daily-candidate/presets/daily-standard/agent.cordis.yml
```

### Where the old value came from

`git log -S "16bc20e5…" --all -- compatibility.lock.json` returns exactly one commit:
`c3b9dba`, the same re-derivation. `git show c3b9dba:<preset>` hashes to `16bc20e5…`.
The pin was correct when written.

### What changed, as a diff

Exactly ONE commit touches the file since the pin:

**`1ea7e89` — "R4: give WorkService runs a real human authorization path (F1 / G-SEAM-31)".**

This is the commit the assignment named as the likely cause, and it is confirmed.
The commit message states the defect: `WorkService.createRun` had exactly one
non-test caller — a hand-run CLI in no production import graph — so the model's work
tool resolved the run first and refused with `this session has no active run`, and the
mandatory N=10 rolling top-up could not be exercised by any user action.

The executable part of its diff is one row:

```yaml
- id: daily-work-command
  name: dsh-daily-work/command
```

preceded by a 14-line comment explaining why the row is in the AGENT PRESET and not
the profile patch: `ctx.commands` layers are keyed by the Agent object, exactly like
`ctx.tools`, so a command registered from the host plane publishes into the root realm
which no agent's scope selects — the human would have a work service and no way to
authorize a run.

### The structural measurement, c3b9dba -> HEAD

```
added=17  blank=1  comment=14  EXECUTABLE=2
  EXE: '- id: daily-work-command'
  EXE: '  name: dsh-daily-work/command'
removed lines            : 0   (pure addition)
CRLF                     : 0
BOM                      : False
tab-indented lines       : 0
trailing-whitespace lines: 0
duplicated row ids       : none
```

`git show 1ea7e89:<preset>` hashes to `05f7a029…` — identical to the working tree —
and `1ea7e89` is an ancestor of HEAD. So this one commit accounts for the whole move.

### The row resolves to something real

A row whose package subpath does not exist would be the "declared but unreachable"
defect this project has recorded a dozen times. Checked:

```
packages/dsh-daily-work/package.json  exports["./command"]
  types   ./lib/command-work.d.ts
  default ./lib/command-work.js
packages/dsh-daily-work/src/command-work.ts   exists (13966 bytes)
packages/dsh-daily-work/lib/command-work.js   exists (11265 bytes, built)
```

### VERDICT: INTENDED. Not a defect.

The one executable change is the fix for the defect the commit names, it is the change
the commit says it is, and it resolves to a built artifact. No accident signature is
present. It is the row that makes `/work start [N]` — the human authorization path —
selectable by the human at all.

---

## The shape of the defect that was NOT present, stated because it is the near miss

The BEFORE run of `doctor.py` (measured by restoring HEAD's lock) prints:

```
[ok  ] identity recomputes from inputs          0a0996f3944b5528...
[FAIL] host_profile_digest   pinned=5b8b2a8e5d9ae13d... disk=0e8e370e06375ad4...
[FAIL] agent_preset_digest   pinned=16bc20e559d0c05b... disk=05f7a029739692db...
```

The old lock WAS internally consistent — `identity_digest(inputs)` equalled the recorded
identity. It was consistent and WRONG, because two of the inputs it hashed no longer
described the files on disk. **An identity recomputation alone cannot catch that**; only
a per-input comparison against the file each pin names can, which is why both checks
exist and why this slice ran both.

This matters for reading the verdicts below: "the identity recomputes" is NOT evidence
that the identity is correct. It is evidence that the lock is self-consistent. The
verdicts here rest on the diff, not on the recomputation.

---

## What would have made either move a DEFECT, and the measurement that rules each out

Recorded explicitly, because a verdict with no falsification condition is an assertion.

| accident signature | measurement | result |
|---|---|---|
| a line-ending change moved the digest | `\r\n` count in each file | 0 and 0 |
| a BOM was added | first byte | no BOM in either |
| an executable line was DELETED | removed-line count in the diff | 0 and 0 |
| a row id was duplicated | `- id:` values, uniq -d | no duplicates in either |
| a machine-specific path leaked in | regex over all added lines | 0 matches |
| a secret leaked in | regex over all added lines | 0 matches |
| an unintended file was touched | commits touching each file since the pin | exactly the commits above, each of which names its own defect |
| the digest was transcribed from the tool rather than computed | second, independent recomputation | MATCH |
| the tool itself is wrong about what it checks | read `rederive-identity.py` and `doctor.py` | see unresolved_unknowns in the lock |

---

## The two inputs the tool does NOT check

`rederive-identity.py`'s `FILE_INPUTS` map covers four inputs. The identity is
computed over 23. The two the assignment asks about:

### `acceptance_spec_sha256` — checked, and did NOT move

It IS in the tool's map (it covers `qualification/specs/acceptance-spec.json`). The
tool reported no move for it, and independently:

```
qualification/specs/acceptance-spec.json
  disk 2fe95835425eb98eb3bac9eead17985df5bf951669460c8d7a87b8887afb1e0b
  lock 2fe95835425eb98eb3bac9eead17985df5bf951669460c8d7a87b8887afb1e0b   MATCH
qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json
  disk e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7
  lock e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7   MATCH
```

So this input is UNMOVED, and it is covered by a gate (`doctor.py` checks it too).

### `resolved_plugin_graph_digest` — NOT checked by any tool. UNMOVED, but weak.

`rederive-identity.py` does not check it. `doctor.py` does not check it. Its
`FILE_INPUTS` / `PATH_INPUTS` maps name neither. **The tool does not check this input
at all**, and that is reported as an unresolved unknown rather than resolved by
assumption.

Measured by hand: the recorded value `23f763d1bf2af8ba3210473d6743bc39ac0185bdefd661861935414a01e5af6b`
IS the sha256 of `qualification/results/M3.1-c2-profile/dump-config-daily-candidate.yml`
on disk. So the pin is internally consistent and I did NOT move it.

But the pinned dump is from `786edb1` (M3.1, 2026-09-19) and no longer describes this
composition. A fresh `--dump-config` of this profile, normalised only for the
per-writer home path, differs as follows:

```
M3.1 dump rows : 164
fresh dump rows: 174
rows REMOVED   : 0
rows ONLY in the fresh dump: daily-data-plane, daily-history, daily-no-sandbox-contract,
  daily-programmatic-scope, daily-web-search, daily-work-tool-protocol-guards,
  daily-writers, fs-local, ipython-kernel-host, pwsh-local
rows present in both but DIFFERENT: agent-presets, approval, daily-work-host,
  fs-sandbox, permission, pwsh-sandbox, sandbox-policy, ui-permission
```

One of those differences is the input that moved: the fresh dump's
`sandbox-policy.mode` reads `danger-full-access` where the pinned dump reads
`!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`.

The OTHER moved input does NOT show up here, and the reason is worth recording rather
than leaving as an apparent omission: the fresh dump contains no `daily-work-command`
row. That is EXPECTED and not a defect — `--dump-config` dumps the HOST plane, and
agent-preset rows are absent from it by construction. Measured: the fresh dump also has
no `daily-work-tools` row (the pre-existing preset row), while `tool-todo` appears
because it is a host row. So the absence of `daily-work-command` from this dump is not
evidence about the row; it is a property of what the dump covers. The row's existence
and reachability were verified directly instead: the preset file contains it and
`packages/dsh-daily-work/package.json` exports `./command` to a built file.

**The finding, stated plainly**: `resolved_plugin_graph_digest` is named as an identity
input and is the digest of a dump file that predates the composition the identity now
describes. The field is not wrong about the file it names; it is a weaker input than
its name suggests, because a DECLARED 2026-09-19 dump is not the RESOLVED 2026-09-20
graph. It is left UNMOVED deliberately — moving it would require a new dump artifact
with its own evidence, which is a measurement for another writer, not a value to be
invented here. `qualification/runners/v2-identity-probe.mjs` exists to measure the
RESOLVED graph from a live boot and carries it as a SEPARATE input
(`resolved_host_graph_measured`) precisely because of this distinction.
