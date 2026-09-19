# The pinned checkout's "modified" state is CRLF, not content

`git status` in `D:\DSH\src\dsh-src` reports one modified file:

```
 M packages/deliverables/workspace-changes/src/index.ts
?? DSHhomem914/
?? data-artifacts/
```

**Measured: there is no content difference.** `git diff --numstat` prints
nothing (empty), and `git diff -w --numstat` also prints nothing. The file is
`ASCII text, with CRLF line terminators`, while the index holds LF. So the
"modification" is a line-ending difference introduced when this install was
moved/restored, not an edit.

`HEAD` is still `ddefc45fbc7f8e46dd73185e68295696d1297887` — the pinned commit.

## Why this matters for the identity gates

`ID-06` requires the first real native tool to work on a qualified launcher, and
a reader could reasonably treat "the checkout is modified" as invalidating that.
It does not, and the distinction should be stated rather than assumed:

- **The artifact is unaffected.** The qualified launcher is the BUILT
  `apps/cli/lib/bin.js`, and `git diff` shows no content change to any source
  file. `artifact_sha256` is recorded in `compatibility.lock.json` and is
  re-checkable against the built file.
- **What is affected is a text-file digest**, if anyone digests the working tree
  rather than the built output. A CRLF checkout and an LF checkout of the same
  commit are byte-different while being content-identical.

## The two untracked directories

`DSHhomem914/` and `data-artifacts/` are untracked and are **not** part of the
pinned commit. They are not this project's and were not created by this
project's agents (all agent homes are under `D:\DSH\home\`). They are recorded
here rather than deleted, because they are unknown files in a tree this project
was told not to modify.
