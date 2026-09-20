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
| `.github/workflows/post-integration.yml` | post-integration CI, Windows primary, 18 steps |
| `.github/workflows/paid-live-provider.yml` | the separate manual paid gate, `BLOCKED_EXTERNAL` by construction |

### Evidence in this directory

| file | what it shows |
|---|---|
| `summary-false-green-before-after.txt` | the headline: `--summary` exit 0 -> 1, both renderers agreeing, 317 unchanged |
| `control-exit0-reachable.txt` | exit 0 is STILL reachable, so the gate discriminates rather than always failing |
| `release-gate-before-fix.txt` | `release-gate` NOT_READY with its 4 blockers, measured |
| `meta-mutations-all-run.txt` | all 10 meta-mutation arms in one pass, 10/10 held |
| `meta-flaky-run.txt` | the 6 FLAKY arms, including the 40-green-rerun non-erasure arm |
| `workflow-validation.json` | which workflow steps were validated locally and which were not |
| `v2-contract-identity-impact.txt` | the pinned-input side effect of editing `verify-spec.py`, with blame separated |

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

---

## 5. THE META-MUTATIONS, AND WHICH ONES WERE ACTUALLY RUN

V5 §4.3 names ten. All ten are implemented in
`qualification/runners/meta-mutations.py` and **all ten were RUN** in a single pass
(`meta-mutations-all-run.txt`, 10/10 held in 40.8s). What differs between them is
the STRENGTH of what was run, and that is stated per arm rather than flattened:

| arm | what was run | strength |
|---|---|---|
| META-SUMMARY | corrupt one evidence sha256 on a COPY of the spec; both renderers must go red and agree | full — the real validator |
| META-CURSOR | mutate `readOrCreateStoreCursorKey` to a constant; the real `data16` test must go red | full — real test, real mutation |
| META-ZERO | 0 tests selected, through the product's own `acceptance.mjs` | full |
| META-SKIP | an all-skipped suite, through `acceptance.mjs` | full |
| META-TIMEOUT | a 60s runner against a 4s deadline, through `acceptance.mjs` | full |
| META-CONSUMER | remove `host.ts`'s import of `counting.ts`; the reachability report must move it to UNREACHABLE | full — but see the note below |
| META-GRAPH | a named stale candidate is refused; the identity-freshness check is red | full for the identity gate |
| META-MARKUP | the inverse arm: a markup-only change must NOT fail a semantic gate | full |
| META-IMPORT | the PREMISE only: a variable-held specifier is invisible to a text scan and resolved at runtime | **partial** |
| META-DATA-ROUTE | the route is absent (`data:` count = 0), so the gate is red | **partial** |

**The two partial arms are partial for the same reason, and it is not a shortcut.**
V5 §4.3 specifies META-IMPORT as "static import scanner may pass, runtime-resolved
graph check must still catch foreign resolution", and META-DATA-ROUTE as
"disconnect bridge data branch, assembled data e2e must fail". Neither the
runtime-resolved graph check nor the assembled data e2e **exists in this tree**:
the bridge has no `data:` routing branch at all (V5 fact 7, re-measured here as 0),
and that is V5 §5's slice, not this one. So what these two arms establish is the
premise each check would rest on, and both record the missing check itself as
`NOT_RUN` rather than claiming it.

**One structural weakness found and recorded rather than hidden:**
`import-graph.mjs` REPORTS unreachable modules but does **not exit nonzero** on
them. So META-CONSUMER's required observation is the reported movement, not an exit
code. A gate that only prints is not a gate, and that is written into the arm's own
output.

---

## 6. WHAT THIS SLICE DOES NOT CLAIM

1. **A meta-tested gate proves the gate can FAIL, not that the product is
   correct.** Every arm here is about the instrument. None of them measures the
   product.
2. **`release-gate` says the RECORD is releasable, not that the oracles in that
   record are the right ones.** It cannot judge that, and it says so in its own
   output.
3. **Neither GitHub workflow has ever run.** See `workflow-validation.json`.
4. **The FLAKY ledger is EMPTY on this tree.** `stability.py` is implemented and
   its arms are mutation-tested, but no runner appends observations yet, so every
   case currently reads `UNOBSERVED`. That is deliberately not `PASS`, and
   `release-gate` treats an unobserved case as having no stability verdict rather
   than as green.
