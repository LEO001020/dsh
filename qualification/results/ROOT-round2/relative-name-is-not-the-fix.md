# My own instruction was wrong: a relative `name:` is NOT the fix for cross-tree probes

Recorded because I gave this instruction to writer S15 and S15 measured it, found it
wrong, and said so instead of following it. The correction is worth keeping: the
next person to see an absolute `name:` in a patch row will reach for the same wrong
answer.

## What I told S15

In the dispatch and in a follow-up I wrote that the supported spelling is relative,
citing the pinned checkout's own tests:

```
packages/boot/app-boot/tests/config-dump.spec.ts:36    '  name: ./noop.mjs',
```

The inference was: `./noop.mjs` resolves against the booting tree, so it is correct
by construction. That inference is wrong, and S15 said so explicitly: *"a relative
`name:` is NOT the fix. `ctx.baseUrl` is the PROFILE directory, not the patch file
and not the repo, so `./probe.mjs` resolves under `$DSH_HOME/profiles/daily/` where
nothing exists."*

## Why the inference was wrong

I checked the mechanism and S15 is right:

```
packages/boot/app-boot/src/index.ts:939
    ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
```

`baseUrl` is the directory of the **composed config**, which is the profile
directory — not the patch file's location and not the repository. The upstream test
I cited passes `./noop.mjs` against a **fixture tree** whose config sits beside the
fixture, so the relative form works there for a reason that does not transfer.

**The general lesson, which is the reason this note exists**: I cited an upstream
test as evidence for a spelling without checking what that test's `baseUrl`
actually was. The citation was real; the inference from it was not. That is the same
failure as the ones this project keeps recording — evidence that is genuine but does
not support the claim built on it.

## The fix that actually works

S15 built `qualification/runners/overlay.mjs`: a shared helper that materialises the
overlay into the RUNNING tree with the running tree's own probe path. The drivers
refuse loudly when the row is missing rather than booting a placeholder.

## Blast radius, measured

S15 fixed 18 patch overlays. **8 remain unfixed**, because their only callers live in
`qualification/results/**`, which is recorded history that must not be edited; one of
those names the sibling `wt-r4`. They are ratcheted so the set cannot grow. S15's own
framing is the honest one and is kept: *"The 8 ratcheted overlays are recorded and
bounded, NOT acceptable."*
