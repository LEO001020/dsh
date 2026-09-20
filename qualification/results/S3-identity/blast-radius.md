# S3: the blast radius. Every artifact bound to `0a0996f3…` is now stale.

Rule being applied, from `helpers/rederive-identity.py`'s own output and from the
lock's `identity_note`:

> EVERY VERDICT BOUND TO THE OLD IDENTITY IS NOW STALE. That is intended: an identity
> proves the inputs have not changed, not that they are right.

**These files are NOT rewritten by this slice.** They are historical evidence for a
superseded identity. Rewriting them would be re-labelling a measurement as having been
taken under an identity it was not taken under — the inheritance the trusted-local spec
explicitly forbids. What follows is the list, and the re-run each one needs.

Scan, reproducible at the pre-change revision (so the numbers do not include this
slice's own files or its lock edit):

```
git grep -l "0a0996f3" HEAD -- . ':(exclude)node_modules'   -> 65 files
git grep -c "0a0996f3" HEAD -- . ':(exclude)node_modules'   -> 860 lines contain it
git grep -o "0a0996f3" HEAD -- . ':(exclude)node_modules'   -> 868 occurrences
```

**65 files / 860 lines / 868 occurrences**, excluding `node_modules`. All per-file
counts below are the `git grep -c` LINE counts at `HEAD`, so they are re-derivable with
the same command. (A JSON parse of the ledger is used for the evidence-entry counts in
section A, because line counts cannot answer "how many entries".)

Two caveats on the scan, so a reader reproducing it is not surprised:
- `HEAD` is used deliberately. In the working tree this slice adds
  `qualification/results/S3-identity/*` (which quote the old identity as the subject of
  the report) and edits `compatibility.lock.json`, so a working-tree grep returns more
  files and would confuse this slice's own prose with a stale artifact.
- `qualification/runners/__pycache__/` can appear in a working-tree grep after any
  runner is imported. It is a build artefact, not evidence.

---

## A. The live ledger — 319 occurrences, the largest single consumer

```
qualification/specs/acceptance-spec.trusted-local-v1.json
```

- 109 cases; status tally `95 PASS / 13 FAIL / 1 BLOCKED_EXTERNAL`.
- **314 of its 317 evidence entries name the old identity.**
- **107 of 109 cases carry at least one such entry.**
- By status: **94 PASS** + **13 FAIL**.
- By family: BR 11, CAP 13, CMP 14, DATA 12, FS 6, ID 6, IPY 14, OBS 6, REC 10, RES 6, VER 9.
- The only two cases with no stale-bound entry are `ID-01` (the artifact-identity case,
  which was FAIL) and `CAP-10` (FAIL).

Measured consequence, `python qualification/runners/verify-spec.py`:

```
BEFORE: identity 0a0996f3944b5528...  ->  3 problem(s)   (exit 1)
AFTER : identity 533c8cb08b2ccd7f...  ->  317 problem(s) (exit 1)
```

314 of the 317 are the identity move. The other 3 are PRE-EXISTING and are NOT caused
by this change: `CMP-07` and `CMP-12` share `qualification/results/V2-composition/boot7-home-override.json`,
and `VER-09` uses `qualification/results/V9-verification/ver09-tier-audit.json`; all
three are the recorded-CRLF-digest problem already filed by `evidence-reuse.py`'s
line-ending audit. They were failing before this slice and are still failing.

**Re-run needed**: all 94 PASSes must be RE-MEASURED under `533c8cb0…`; the 13 FAILs
must be RE-JUDGED under it. `BLOCKED_EXTERNAL` (IPY-08) stays blocked on the
authorization, not on the identity.

## B. The E3 evidence-reuse evaluation — 324 occurrences

```
qualification/results/trusted-local-v2-identity/evidence-reuse.json
```

This runner recomputes the v1 identity from the lock's CURRENT inputs
(`qualification/runners/evidence-reuse.py:287-304`) and requires each evidence entry to
name the lock's identity. Before this slice it had decided **2 of 108 cases eligible
for E3 reuse: `CMP-08` and `CMP-14`**.

After the identity move, both are refused. Called read-only through the runner's own
`evaluate_case`:

```
--- CMP-08 (v1 status PASS) ---   eligible: False
  REFUSAL: E3.1: the evidence names identity/identities ['0a0996f3944b5528']
           but the lock's is 533c8cb08b2ccd7f
  REFUSAL: E3.4: no candidate digest the artifact names matches the current build.
--- CMP-14 (v1 status PASS) ---   eligible: False   (same two refusals)
```

So the E3 reuse decision is now **0 eligible / 108 refused**, and its recorded
`G-DOCTOR` gate flips from `exit_code 0 / passed true` to `exit_code 1 / passed false`
because `doctor.py` was failing at the time that artifact was written and now passes.
**Re-run needed**: `python qualification/runners/evidence-reuse.py`. Its output is a
generated artifact, and re-running it is the correct action; the old file is evidence
for the old identity.

Note: running it writes into `qualification/results/trusted-local-v2-identity/`, which
this slice does NOT own. It was run once here to capture the before/after and the
resulting diff was reverted; see `../S3-identity/side-effect-note.md`.

## C. The per-family GATES.md files — every V-family slice

```
qualification/results/V6-recovery/GATES.md                  7
qualification/results/V2-composition/GATES.md               3
qualification/results/V5-data/GATES.md                      3
qualification/results/V8-capacity/GATES.md                  3
qualification/results/V1-identity/GATES.md                  4
qualification/results/V9-verification/GATES.md              2
qualification/results/V3-ipython/GATES.md                   1
qualification/results/V4-bridge/GATES.md                    1
qualification/results/V7-fs/GATES.md                        1
qualification/results/V10-research-obs/GATES.md             1
```

V6's own text is the clearest statement of what is now true of all of them: "the
identity literal `0a0996f3…` still recomputes from the lock's inputs" — which was true
when written and is now false.

**Re-run needed**: each family's measurements must be re-run under the new identity and
re-filed. The GATES.md files are NOT to be edited in place; they are the record of what
was measured under `0a0996f3…`.

## D. Per-slice evidence and probe artifacts

```
qualification/results/V1-identity/ID-02-ID-04-identity-rederivation.txt   5
qualification/results/V1-identity/ID-03-no-inheritance.txt                1
qualification/results/V1-identity/ID-04-verify-identity-live.txt          6
qualification/results/V1-identity/runs/id01/boot.json                     2
qualification/results/V1-identity/runs/id01/verdict.json                  3
qualification/results/V1-identity/runs/id03/spec-at-head.json           102
qualification/results/V1-identity/file-verdicts.py                        2
qualification/results/V2-composition/cmp14-launcher-args.json             1
qualification/results/V2-composition/file-cmp-cases.py                    1
qualification/results/V3-ipython/build-identity.txt                       2
qualification/results/V3-ipython/file-cases.py                            1
qualification/results/V4-bridge/probe-wiring.mjs                          1
qualification/results/V4-bridge/source-digests.txt                        1
qualification/results/V5-data/file-verdicts.py                            1
qualification/results/V5-data/source-digests.txt                          1
qualification/results/V6-recovery/file-rec-cases.py                       1
qualification/results/V6-recovery/rec03-crash-before-admission.json       1
qualification/results/V6-recovery/rec03-run.txt                           1
qualification/results/V6-recovery/source-digests.txt                      1
qualification/results/V8-capacity/prod-capacity-report.json               2
qualification/results/V8-capacity/run-v8-capacity-boot.mjs                2
qualification/results/V9-verification/identity-at-measurement.txt         2
qualification/results/V9-verification/ver09-tier-audit.json               2
qualification/results/V9-verification/ver09-tier-audit.txt                1
qualification/results/V9-verification/VER-01..VER-09 (9 files, 1 each)    9
.probe/r2f4/id01-overlay-wt.yml                                           1
.probe/r2f4/runs/id01/boot.json                                           2
```

(The 9 `VER-0x` lines are listed as one row because each is exactly 1; `VER-09` is 4
and is listed separately above.)

The nine `VER-0x` files are the verification-family verdicts; each is bound to the old
identity by construction. `V9-verification/identity-at-measurement.txt` is literally
the record of which identity was in force at measurement time, so it is stale by
definition and must not be edited to look current.

## E. Runners that NAME the old identity in code (not just in output)

```
qualification/runners/evidence-reuse.py                          1
qualification/runners/v6-rec03-crash-before-admission.mjs        1
qualification/runners/v7-file-fs-cases.py                        1
qualification/results/V1-identity/file-verdicts.py               2
qualification/results/V2-composition/file-cmp-cases.py           1
qualification/results/V3-ipython/file-cases.py                   1
qualification/results/V5-data/file-verdicts.py                   1
qualification/results/V6-recovery/file-rec-cases.py              1
qualification/results/V10-research-obs/file-v10-cases.py         1
```

These are the **highest-priority re-runs**, because a runner that hardcodes the old
identity will file its next result under a stale value. `evidence-reuse.py` is the one
whose hardcoded literal is only in a docstring/comment (it recomputes from the lock),
but the others must be checked by whoever re-runs them. This slice does not edit them:
they are outside its file ownership and a hardcoded identity is a decision for the
slice that owns the measurement.

## F. Identity-split artifacts

```
qualification/results/trusted-local-v2-identity/split-self-test/identity.json      1
qualification/results/trusted-local-v2.88834ae45ad7/identity.json                  1
qualification/specs/frozen/FREEZE-RECORD.json                                      4
```

The `trusted-local-v2.*` result directories are filed under a CONTRACT identity, which
is derived from the RUNTIME identity, so the runtime move moves them too. The
FREEZE-RECORD names the old identity as the identity the frozen spec was authored
under; that is a historical statement and stays.

## G. Root and documentation

```
compatibility.lock.json                                 5  -> now updated by this slice
README.md                                               2
docs/GAPS.md                                            2
docs/decisions/AUDIT-REQUEST-acceptance-results.md      3
docs/exec-plans/v3-remediation-brief.md                 1
docs/exec-plans/v3-round1-dispatch.md                   1
docs/exec-plans/v3-round2-brief.md                      1
qualification/results/ROOT-verification/STATUS-final.md         2
qualification/results/ROOT-verification/STATUS-wave2.md         1
qualification/results/ROOT-verification/STATUS-wave2-final.md   1
```

`README.md`, `docs/GAPS.md` and the STATUS files describe the deployment as being at
`0a0996f3…` with a 95/13/1 tally. That description is now historical. They are NOT
edited by this slice (`docs/GAPS.md` is explicitly outside its ownership); the root
agent decides whether they are updated or annotated.

---

## The single-sentence version, for a reader who reads only one line

**Every one of the 109 filed cases, all ten family GATES.md files, the E3 reuse
decision (2 eligible -> 0 eligible), and the nine verification verdicts were measured
under `0a0996f3…` and are now stale as evidence for `533c8cb0…`; they must be
re-measured, not re-labelled.**
