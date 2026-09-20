# The cross-tree sweep is larger than one slice: 59 of 86 runners

Writer S15 owns the cross-tree hazard sweep. This note records the SIZE of what it
is sweeping, measured by the root agent, so the report can be read against a known
baseline rather than S15's sample.

## The count

```
$ grep -rln "dsh-native-daily" qualification/runners/ | wc -l
59
$ ls qualification/runners/ | wc -l
86
```

**59 of 86 files under `qualification/runners/` name the MAIN tree
`D:/DSH/work/dsh-native-daily` by absolute path.** That is not a typo in one file;
it is the prevailing convention in that directory.

## Why it matters, and why it is not uniformly a bug

Two of the hits are of DIFFERENT kinds, and conflating them would be a mistake:

- **Read paths.** `run-t3-shell.mjs:29` sets `RESULT_DIR` to the main tree;
  `import-graph.mjs:44` resolves a package root there. A re-run from any other
  checkout reads or writes a tree that is not the caller's own.
- **Session cwd.** Several runners create a real Session with
  `cwd: 'D:/DSH/work/dsh-native-daily'` (e.g. `v10-obs-plane.mjs:72,74`,
  `v3-ipython-surface.mjs:85`, `v10-res01-chain.mjs:103`). Here the absolute path
  is arguably MEANINGFUL: the probe wants a workspace that is not the profile
  directory, and naming the main tree is one way to say that. Whether it is a
  defect depends on whether the runner's RESULT is then attributed to the tree it
  ran in — which is the actual question.

So the classification S15 must make is not "does this file contain an absolute
path" but "**can this runner's output be attributed to the tree that produced
it**". A runner that reads the main tree but writes into its own tree is reporting
a fact about the main tree; one that reads its own tree and writes into the main
tree is corrupting someone else's evidence. The second is the `G-SEAM-66` class.

## The correct pattern already exists in this repo

`qualification/runners/r5-bridge-product.mjs` is the model, and it is worth citing
because it shows the fix is cheap:

```js
const OUT = process.env.DSH_PROBE_OUT
if (OUT === undefined || OUT === '') {
  throw new Error('r5-bridge-product: DSH_PROBE_OUT must name this caller\'s own '
    + 'result path; a shared fixed path cannot be attributed to a caller')
}
```

It REFUSES TO RUN without an explicit per-caller output path, and its comment
states the reason: a probe writing to a fixed path "into a tree the caller does
not own". A hard failure is better than a silent cross-tree write, and it makes the
hazard impossible to hit by accident.

## The sibling-worktree literals are strictly worse

Writer S15 identified a second class the reconnaissance did not: literals naming a
SIBLING writer's checkout, which appear in tracked files:

```
qualification/runners/run-v2-identity.mjs:27            const REPO = 'D:/DSH/work/wt-r0'
qualification/runners/v2-identity-probe.mjs:45,64       ... 'D:/DSH/work/wt-r0' ...
qualification/runners/r7-cursor-realm-probe.mjs:48,82   ... 'D:/DSH/work/wt-r7' ...
qualification/runners/verify-r4-authorization.mjs:47,220,353  ... 'D:/DSH/work/wt-r4' ...
qualification/runners/r5-bridge-product.patch.yml:14    name: 'D:/DSH/work/wt-r5/...'
qualification/runners/r7-cursor-realm.patch.yml:35      name: 'D:/DSH/work/wt-r7/...'
qualification/runners/v2-identity.patch.yml:12          name: 'D:/DSH/work/wt-r0/...'
qualification/runners/verify-r4-authorization.patch.yml:14    ... 'wt-r4' ...
```

A main-tree default is at least a *stable* default. `wt-r0`/`wt-r4`/`wt-r5`/`wt-r7`
name checkouts that are round-1 writer worktrees — they exist today, but they are
scratch trees with no guarantee of survival, and a re-run from anywhere reads or
writes a tree that is not the runner's own. S15's classification of these as live
hazards, separate from the main-tree default, is correct.

## What this note does NOT claim

It does not claim all 59 are defects. It claims the count, the two kinds of hit,
the question that decides each one, and that the correct pattern already exists in
the same directory. S15 owns the per-file classification and the gate.
