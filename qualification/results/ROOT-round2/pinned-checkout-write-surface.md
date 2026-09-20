# The pinned checkout is a `blob:none` partial clone: "read-only git" is not achievable

Disclosed by writer S12 while establishing ID-06's verdict, then independently
re-verified here. It is recorded separately because it generalises beyond the
incident that revealed it, and because it constrains what "we did not touch the
checkout" can honestly mean.

## The incident S12 disclosed

Establishing whether a tracked blob was present locally, S12 ran
`git cat-file -e <missing-object>`. That triggered a **lazy fetch** which wrote a
new pack into the pinned checkout:

```
.git/objects/pack/pack-681ade73241f5d72f6179cfcc64b470c7403ebd5.pack
  130682 bytes, 2026-09-20 18:41:31
```

It contains exactly the one blob that was requested. No worktree file changed and
HEAD did not move, but the instruction for this wave was "do not touch the
checkout", and this touched `.git`.

## The generalisation, which is the reason this note exists

The checkout is a partial clone:

```
$ git config --get remote.origin.promisor       -> true
$ git config --get remote.origin.partialclonefilter -> blob:none
```

In a `blob:none` clone, **blob contents are not local**. Any git command that reads
a blob the local packs do not already hold — `cat-file`, `show`, `diff` against a
tree, even some `status` paths — will fetch it and write into `.git`. So "read-only
git in this checkout" is **not a property that can be fully achieved by discipline**;
it depends on which objects happen to be local, which is not visible from the
command being typed. A future instruction of the form "run only read-only git
commands here" is therefore not enforceable as written.

What IS enforceable is the thing the oracle actually measures: no **worktree** file
changed and HEAD did not move. Both hold, re-measured after the write:

```
$ git rev-parse HEAD
ddefc45fbc7f8e46dd73185e68295696d1297887
$ git status --porcelain
 M packages/deliverables/workspace-changes/src/index.ts
```

## The store is sound

```
$ git fsck --no-progress --connectivity-only
(exit 0; only "dangling commit" lines, which are ordinary unreferenced history)
```

No missing objects, no corruption. The dangling commits are pre-existing history,
not damage from this wave.

## A second pack, NOT attributable to S12

```
.git/objects/pack/pack-c0fc169b5f51e445239ca34eff50a80549658b4f.pack
  26613708 bytes, 2026-09-20 18:37:22
```

Its body was rewritten at 18:37:22 while its `.idx` still dates from 2026-09-19
10:41:54. That is **not** the shape of a lazy fetch — a lazy fetch creates a new
pack (as S12's did, with a matching fresh `.idx`). The cause is UNKNOWN and is
recorded rather than explained. It falls inside this wave's window with fifteen
writers live, so a later pass should check whether any runner performs a `git gc`
or `repack`, and whether anything else on this machine touches this checkout.

## The honest form of "we did not modify the checkout"

- **No worktree file was written.** `find` over the whole checkout for files newer
  than 2026-09-20 00:00 returns 0.
- **HEAD is unmoved** and equals the pinned `ddefc45f…`.
- **`.git` was written twice** — once by S12's lazy fetch, once by an unexplained
  pack rewrite. Neither is a source deviation; both are recorded.

That is a stronger and more useful claim than "untouched", which would be false.
