# P1 — qualification authority: the false-green fix, the release gate, and the meta-mutations

**Slice:** P0.2 of V5 round 3 — fix the qualification validator's false-green path and
build the post-integration CI that V5 §17 calls mandatory.
**Worktree:** `D:\DSH\work\wt-p1` (branch `wt/p1`).

This directory is the evidence index for the slice. It exists so a reader can go from
a claim in the report to the command that produced it.

---

## 1. THE HEADLINE, MEASURED BEFORE AND AFTER

`verify-spec.py --summary` exited **0** while the full path exited **1** with **317
problems**. That is the defect V5 §4.1 names, and it was previously measured by writer
S3 and re-measured by root (see `qualification/results/ROOT-round2/verify-spec-summary-false-pass.md`,
which documented the trap and correctly declined to edit a runner it did not own).

```
# BEFORE (commit 2e1b2c2, the published HEAD)
$ python qualification/runners/verify-spec.py --summary  > out 2>&1 ; echo $?
0                                     <-- false green
$ python qualification/runners/verify-spec.py            > out 2>&1 ; echo $?
1
verify-spec: 317 problem(s).

# AFTER (this slice)
$ python qualification/runners/verify-spec.py --summary  > out 2>&1 ; echo $?
1
VALIDATION=FAIL problems=317 cases=109 identity=533c8cb08b2ccd7f

$ python qualification/runners/verify-spec.py            > out 2>&1 ; echo $?
1
VALIDATION=FAIL problems=317 cases=109 identity=533c8cb08b2ccd7f
```

**The full path still reports exactly 317.** That is the measurement that shows the
refactor preserved validation semantics rather than changing them: the problem count
did not move, only the summary path's willingness to lie about it.

---

## 2. WHY THE FIX IS STRUCTURAL RATHER THAN A PATCHED RETURN VALUE

The old structure made the false green unavoidable, because the summary path *did not
run the validation*:

```python
if args.summary:
    counts = Counter(...); print(...)
    return 0                      # <-- BEFORE all validation
# ...full validation happens here, 317 problems found, exit 1
```

Changing `return 0` to `return 1` would have fixed the exit code while leaving the
structure that produced it: a second path through the function that decides its own
answer without consulting the checks. The fix moves **all** checking into one function,
`validate_everything()`, which returns one `ValidationResult`, and makes both renderers
pure consumers of it:

```python
result = validate_everything()        # ONE result, all checks, always run
render_summary(result) if args.summary else render_full(result)
return result.exit_code
```

Neither renderer performs any validation, so neither can return early. The only way to
reach a renderer is to have already validated everything. Both print the same
machine-readable first line, so a consumer that greps one string gets the same answer
from either path.

---

## 3. THE FILES IN THIS SLICE

| file | what it is |
|---|---|
| `qualification/runners/verify-spec.py` | rewritten: one `ValidationResult`, two renderers, exit 0/1/2 |
| `qualification/runners/release-gate.py` | NEW: the release decision, separate from spec validity |
| `qualification/runners/stability.py` | NEW: the append-only stability ledger and the derived FLAKY verdict |
| `qualification/runners/meta-flaky.py` | runnable meta-test for the FLAKY non-erasure property |
| `qualification/runners/meta-mutations.py` | runnable meta-tests: each must make its gate go RED |
| `.github/workflows/` | post-integration CI, Windows primary, plus the separate manual paid gate |

---

## 4. THE SEPARATION THAT V5 §4.2 ASKS FOR, AND WHY IT IS TWO FILES

`verify-spec` answers one question: *is the recorded evidence well-formed and bound to
this identity?* It checks schema, evidence path, hash, identity binding, and
status/evidence coherence. It deliberately does **not** judge whether an oracle was
established, and it does not decide whether the candidate may ship.

`release-gate` answers the second question: *may this exact candidate be released?* It
requires `verify-spec` to pass, then adds: fresh runtime identity, all mandatory
evidence-level requirements, no FAIL, no FLAKY, no NOT_RUN, no INVALIDATED, no stale
evidence, only explicitly allowlisted `BLOCKED_EXTERNAL`, and post-integration
assembled-product cases passed.

A single tool answering both would have to be lenient about one of them — which is
exactly how the `--summary` path came to exist.
