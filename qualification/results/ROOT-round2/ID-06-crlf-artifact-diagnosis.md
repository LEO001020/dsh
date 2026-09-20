# ID-06: the pinned checkout's one dirty entry, diagnosed to its mechanism

## The measurement

```
$ git -C D:/DSH/src/dsh-src rev-parse HEAD
ddefc45fbc7f8e46dd73185e68295696d1297887          # == compatibility.lock.json upstream_commit

$ git -C D:/DSH/src/dsh-src status --porcelain
 M packages/deliverables/workspace-changes/src/index.ts

$ git -C D:/DSH/src/dsh-src status --porcelain --untracked-files=all
 M packages/deliverables/workspace-changes/src/index.ts          # nothing else
```

## It is NOT a content change, in git's own accounting

```
$ git diff --numstat
(warning: in the working copy of '...', CRLF will be replaced by LF the next time
 Git touches it)
(empty output -- no content delta)

$ git rev-parse HEAD:packages/deliverables/workspace-changes/src/index.ts
c05787d931870defacfdfcb4feca85f4ae733d8e
$ git hash-object --path=packages/deliverables/workspace-changes/src/index.ts <file>
c05787d931870defacfdfcb4feca85f4ae733d8e          # IDENTICAL
```

`hash-object --path=` applies the clean filter, so this compares the file AS GIT
WOULD COMMIT IT against HEAD's blob. They are the same object.

## The mechanism, read from the checkout's own configuration

```
$ git ls-files --eol packages/deliverables/workspace-changes/src/index.ts
i/lf    w/crlf  attr/text=auto eol=lf

$ git check-attr -a packages/deliverables/workspace-changes/src/index.ts
text: auto
eol: lf

$ git config --get core.autocrlf
true

$ python: bytes of the worktree file
total \n: 165 | \r\n: 165 | bare LF: 0     (7251 bytes)
```

So: the index holds LF, `.gitattributes` requires `eol=lf` on checkout, the
worktree file is **entirely CRLF** (165 CRLF, zero bare LF), and `core.autocrlf` is
`true` — which asks for the opposite of the attribute. The file was written by
something that did not honour the attribute. Because the clean filter maps CRLF
back to LF, the content still hashes to HEAD's blob, which is why `numstat` is
empty while `status` flags it.

## Pre-existing, not introduced by this wave

The file's mtime is `2026-09-19 19:19:47`, the day BEFORE this wave began. It is
already characterised in `qualification/results/ROOT-verification/pinned-checkout-state.md`
and `qualification/results/V1-identity/ID-06-pinned-checkout-state.txt`.

## The tree is CLEANER than its own recorded baseline

The earlier record captured TWO untracked directories that are now gone:

```
?? DSHhomem914/
?? data-artifacts/
```

Both are absent today, and neither is gitignored (`git check-ignore` reports no
match), so they were removed rather than hidden. The current state has one flagged
entry and zero untracked files.

## The verdict question, stated rather than decided

ID-06's oracle is strict and admits no judgement call:

> "The working tree is clean and HEAD equals `ddefc45f…`. **Any tracked
> modification**, any staged change, or a moved HEAD is NOT PASS."

The CRLF-flagged file IS a tracked modification by git's own report. So on the
literal oracle the case is **FAIL**, and the honest verdict states both facts — the
` M` line AND the identical blob hash — so a reader cannot mistake a line-ending
artifact for a source deviation, or vice versa. Writer S12 owns the final call and
was given these measurements to verify rather than adopt.

## What must NOT be done about it

The temptation is `git update-index --refresh` (or `--really-refresh`) to clear the
stat cache. **That writes to `.git/index` inside the pinned checkout**, which is
exactly the class of action the project forbids: making a gate pass by changing the
thing the gate measures. The checkout is read-only for this wave. If the flag is
ever cleared, it must be a deliberate, recorded decision with the oracle text in
hand — not a side effect of wanting a green result.

## What is NOT established here

Whether the CRLF state predates the pin itself or arrived with some later checkout
was NOT determined. Only its mtime relative to this wave was.
