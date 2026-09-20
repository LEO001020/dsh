# An absolute `name:` in a patch file is CROSS-TREE CODE EXECUTION

Found by writer S15 while sweeping cross-tree hazards; the mechanism was traced in
the pinned source by S15 and independently re-verified by the root agent at the
lines quoted below. It is recorded here separately because it is a different and
worse class than the rest of the sweep, and because the count is large.

## The mechanism, read from the pinned checkout

`packages/boot/app-boot/src/index.ts:521`:

```ts
const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
```

and `vendor/include/src/index.ts:181`:

```ts
this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
```

So a patch row whose `name:` is an ABSOLUTE path is loaded from **that exact
file**, regardless of which tree is booting. It is not a relative read that
resolves against the booting tree — it is an absolute URL handed to the loader,
and the loader **executes** it.

## Why that is worse than a cross-tree read

The other hits in this sweep read or write the wrong tree's *data*. This one makes
a boot in worktree A **run a `.mjs` from worktree B** while the product under test
is A's. Every fact such a probe reports is then a fact about a probe that is not in
the tree being measured — and the product's own behaviour is the only thing that is
A's. A probe is not passive: it mounts rows, creates sessions, and writes results.

## The count

```
$ grep -rln "name: 'D:/DSH/work/dsh-native-daily" qualification/runners/*.yml .probe/*.yml
26
$ grep -rln "name: 'D:/DSH/work/wt-" qualification/runners/*.yml .probe/*.yml
15
```

**41 patch files, of which 15 name a round-1 WRITER'S SCRATCH WORKTREE**
(`wt-r0`, `wt-r1`, `wt-r5`, `wt-r7`). Those are strictly worse than the main-tree
default: they are scratch trees with no guarantee of survival, so a re-run either
executes a stale probe or fails in a way that looks like a product defect.

Representative hits:

```
qualification/runners/r7-cursor-realm.patch.yml:35   name: 'D:/DSH/work/wt-r7/qualification/runners/r7-cursor-realm-probe.mjs'
qualification/runners/r5-bridge-product.patch.yml:14 name: 'D:/DSH/work/wt-r5/qualification/runners/r5-bridge-product.mjs'
qualification/runners/v2-identity.patch.yml:12       name: 'D:/DSH/work/wt-r0/qualification/runners/v2-identity-probe.mjs'
.probe/mount-latency.patch.yml:3                     name: 'D:/DSH/work/wt-r1/.probe/measure-mount-latency.mjs'
qualification/runners/verify-t3-shell.patch.yml:35   name: 'D:/DSH/work/dsh-native-daily/qualification/runners/verify-t3-shell.mjs'
```

## The supported spelling is relative

The pinned checkout's own tests use the relative form, which resolves against the
booting tree and is therefore correct by construction:

```
packages/boot/app-boot/tests/config-dump.spec.ts:36    '  name: ./noop.mjs',
packages/boot/app-boot/tests/config-dump.spec.ts:41    '  name: ./noop.mjs',
packages/boot/app-boot/tests/config-dump.spec.ts:59    '      name: ./noop.mjs',
```

So the fix is not an invention: the pinned upstream demonstrates the supported
form in its own test suite.

## The three live WRITE hits, found first

S15 found these before the mechanism, and they are the ones that actively corrupt
evidence — absolute literals, not env-overridable at all, writing into a directory
that a TEST then reads:

```
qualification/runners/verify-c2-service.mjs:25   -> M8.5-c2-real-boot/finding.json
qualification/runners/verify-tools.mjs:23        -> M8.5-c2-real-boot/tools-host.json
qualification/runners/verify-preset-tools.mjs:40 -> M8.5-c2-real-boot/preset-tools.json
```

`dep-gates.test.ts:188` reads `M8.5-c2-real-boot/e2e-tool.json`, and the C2 verdict
rests on `finding.json`. So a writer in a worktree overwrites the MAIN tree's
evidence, and that evidence is then consumed as if it came from the main tree.

## What is NOT claimed here

Not every hit is a defect. A session `cwd` naming the main tree is a WORKSPACE the
probe asks the product to operate in, and the oracle there is "the product honoured
the requested cwd" — the literal is meaningful, not a hazard. S15 is classifying by
kind and will report the census with an explicit sample; this note records the
mechanism and the count for the code-execution kind only.
