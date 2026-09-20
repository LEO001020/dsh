# S3: a side effect I caused, disclosed rather than hidden

## What happened

To measure the BEFORE state of the E3 evidence-reuse decision, this slice ran

```
python qualification/runners/evidence-reuse.py
python qualification/runners/evidence-reuse.py --json
```

That runner is not read-only. It writes into
`qualification/results/trusted-local-v2-identity/`, which this slice does NOT own.
It modified six tracked files:

```
qualification/results/trusted-local-v2-identity/evidence-reuse.json
qualification/results/trusted-local-v2-identity/mutation-test.json
qualification/results/trusted-local-v2-identity/split-self-test/GATES.md
qualification/results/trusted-local-v2-identity/split-self-test/evidence-manifest.json
qualification/results/trusted-local-v2-identity/split-self-test/identity.json
qualification/results/trusted-local-v2-identity/split-self-test/verdicts.json
```

## What was done about it

The diff was captured to `.s3tmp/ACCIDENTAL-side-effect.diff` (278 lines) and then
reverted with `git checkout -- qualification/results/trusted-local-v2-identity/`, so
those files are byte-identical to `HEAD` and this slice commits none of them.
`git status --porcelain` shows only `compatibility.lock.json` modified, plus the two
new untracked paths this slice owns.

## Why it is recorded rather than quietly reverted

Because the reverted content is itself a MEASUREMENT of the blast radius, and it is the
clearest single piece of evidence that the identity move is consequential:

```diff
         "id": "G-DOCTOR",
-        "exit_code": 0,
-        "passed": true,
-        "tail": "This is a metadata check. It does not boot anything and is not a qualification."
+        "exit_code": 1,
+        "passed": false,
+        "tail": "against the old identity is invalidated by the new one; that is intended."
```

That is `G-DOCTOR` flipping from green to red, and the reason is instructive: when the
artifact was filed, `doctor.py` was FAILING (the lock was stale) and this slice's edit
made it PASS — but the reuse evaluator reads the v1 identity out of the lock, so the
same edit turns its own E3.1 condition false. Both facts are real; the artifact as
filed is evidence for the old identity, and the re-run belongs to whoever owns that
directory.

The second diff hunk is a pure environment artefact and is NOT a finding:

```diff
-        "tail": "record: D:\\DSH\\work\\wt-r0\\qualification\\results\\..."
+        "tail": "record: D:\\DSH\\work\\wt-s3\\qualification\\results\\..."
```

The runner records the path it wrote to, so running it from any worktree changes that
string. It would have changed no matter which writer ran it. A reader who saw only this
hunk would over-read the result.

## The consequence for a later writer

`qualification/results/trusted-local-v2-identity/evidence-reuse.json` in the tree is
bound to the OLD identity and its `G-DOCTOR` gate is recorded as passing against a lock
that has since been corrected. Re-running the runner is the right action and it will
produce the post-move numbers (0 of 108 eligible, `G-DOCTOR` passing). It is not done
here because the directory is outside this slice's ownership.

## One further artefact, from reading the runner rather than running it

Importing `qualification/runners/evidence-reuse.py` in-process (to call its own
`evaluate_case` read-only, which is how the two E3.1 refusals above were produced
without writing a file) creates `qualification/runners/__pycache__/`. It was removed.
It is untracked build output, but it DOES contain the old identity string, so a reader
reproducing the grep in `blast-radius.md` may see it and should ignore it.
