# Root-agent tooling verification

Two tools the delivery depends on did not exist, and one existed but nothing read
it. All three are now in place and verified in both directions.

## 1. `helpers/doctor.py` — did not exist, both manuals told operators to run it

`docs/OPERATIONS.md:198` and `docs/DELIVERY.md:281` both said:

```sh
python <delivery>/helpers/doctor.py --source /d/DSH/src/dsh-src
```

No `helpers/` directory and no `doctor.py` existed anywhere — not in this
repository, not in the audit package it was derived from. **A manual whose first
diagnostic step points at a missing file fails the operator at the moment they
need it most.**

I wrote the file rather than deleting the reference. Deleting would have been the
smaller edit and the worse outcome: the check it describes is genuinely useful and
both manuals were right to want it.

What it does: reads `compatibility.lock.json`, re-derives the deployment identity
from `deployment.inputs`, and verifies every file-named input against disk. That
is the check this project has needed five times — the identity has been re-derived
five times and **three of those were corrections of a real defect**, not drift:
`launcher_realpath` once contained a BEL byte and a backspace from Python escape
processing (and the *mangled* string was what the hash covered, so the identity
described a path that does not exist), and `host_profile_digest`,
`agent_preset_digest` and `agent_preset_id` all went stale today.

| Direction | Result |
|---|---|
| clean tree | exit 0 — `every recorded input matches the tree` |
| one input corrupted | exit 1 — names BOTH symptoms: the identity no longer recomputes, AND which input is stale, with both hashes |

Exit 2 is reserved for an unusable lock, kept distinct so a broken invocation
cannot read as a stale tree.

## 2. `qualification/runners/verify-spec.py` — did not exist, and ten agents were filing into the spec

Nothing read `acceptance-spec.trusted-local-v1.json` back. Ten agents are marking
cases PASS in parallel; a case marked PASS by the same agent that ran the
measurement, with no check that the evidence file exists, hashes correctly, and
was filed under the current identity, records a claim rather than verifying one.

It enforces the mechanical properties: unique ids against the declared family
prefixes, status in the declared vocabulary, `NOT_APPLICABLE` forbidden in `cases`,
a PASS whose evidence exists and hashes to the recorded value, evidence paths
repo-relative under `qualification/results/`, evidence filed under the current
identity, and status/artifact agreement (a non-verdict carries no evidence; a FAIL
says why). It also checks `family_counts` sums to the case count.

It explicitly does **not** judge whether an oracle was established, and says so in
its own output — that is a reading, and a script claiming to decide it would be a
second oracle.

| Direction | Result |
|---|---|
| clean spec (109 NOT_RUN) | exit 0 |
| four injected defects | exit 1, naming all five problems |

The injected defects were: a PASS whose evidence file does not exist, a forbidden
`NOT_APPLICABLE`, an evidence path escaping the results root, and evidence
attached to a `NOT_RUN`. Restored → exit 0.

**Its first version was broken and reported all 109 cases as wrong**, because the
prefix check compared the id prefix to the family's *descriptive* name while the
family is `CONCURRENCY` and the prefix is `CAP`. `family_counts` IS the prefix
map, so it is checked against that. The check was broken, not the spec.

## 3. `qualification/runners/acceptance.mjs` — existed, verified working end to end

It snapshots the declared inputs, runs a command, records the outcome with a tree
digest, and distinguishes exit 2 (malformed invocation / operator error) from
exit 1 (the candidate did not pass) so a broken invocation cannot read as a failed
candidate.

Verified both paths on this machine:

| Definition | Result |
|---|---|
| `node -e "process.exit(0)"` | `outcome: pass`, `passed: true`, snapshot `stableDuringRun: true` |
| the same with `expectedExitCode: 0` and a command exiting 2 | `-> fail (NOT PASS)`, `exit code 2 did not match the expected 0` |

**A note on the snapshot, learned by getting it wrong first**: I pointed an
acceptance definition at `helpers/doctor.py` and it exited 2, because the snapshot
contains only the *declared inputs* — the doctor script itself was not in the
sandbox. That is correct behaviour and worth knowing before writing a definition:
a command whose own program is not among the declared inputs will not be found.
