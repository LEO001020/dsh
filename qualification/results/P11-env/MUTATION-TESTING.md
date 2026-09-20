# P11 / P1.4 — mutation testing of the ENV-DIGEST gate

V3 §3.3 and round-3 §7 both require it: **a passing test you did not watch fail is
not evidence**, and a guard that never fires and a guard that is absent produce
identical evidence. So the new gate was deliberately broken twice.

The rule for a gate like this is asymmetric, and it is why two mutations were run
rather than one:

- **Arm 1** (a real file change moves the digest) must be RED when the digest stops
  seeing file content.
- **Control** (the same environment twice gives the same digest) must stay GREEN,
  or a digest that moves on every call would pass arm 1 while being useless.

A single mutation cannot check both.

## Mutation 1 — remove the file read from the manifest

`manifestWithLocalFiles`, `kernel-plugin.ts`:

```diff
-      broker_sha256: fileDigestOrNull(this.config.brokerScript ?? DEFAULT_BROKER_SCRIPT),
+      broker_sha256: fileDigestOrNull(undefined),
```

Result — **2 of 5 arms RED**:

```
× a changed broker.py moves the digest AND makes a live kernel be refused
× every manifest field is an input to the digest, and the client hash is the real one
✓ the probe reports the interpreter's REAL versions, cross-checked independently
✓ the same environment gives the same digest twice, so a healthy kernel is not refused
✓ an interpreter that cannot be probed FAILS LOUD rather than digesting a partial manifest

AssertionError: expected null not to be null
AssertionError: expected null to be '3393c3de8f522ecd8852e5d96714bb9b8de9e…'
```

The failing assertion is `expect(mutated.manifest?.broker_sha256).not.toBe(baseline.manifest?.broker_sha256)` — the field became `null`, so it could not differ. **The control arms stayed green**, which is what makes the two red arms attributable to the mutation rather than to a test that breaks whenever the code changes.

## Mutation 2 — restore the OLD digest expression

`resolveEnvironmentDigest`, `kernel-plugin.ts` — the actual defect being fixed:

```diff
-    return createHash('sha256').update(canonicalManifestJson(await this.resolveEnvironmentManifest())).digest('hex')
+    return createHash('sha256').update(`${this.config.pythonExecutable}\u0000${process.platform}\u0000${process.arch}`).digest('hex').slice(0, 16)
```

Result — **3 of 5 arms RED**:

```
× a changed broker.py moves the digest AND makes a live kernel be refused
× every manifest field is an input to the digest, and the client hash is the real one
× the probe reports the interpreter's REAL versions, cross-checked independently
✓ the same environment gives the same digest twice, so a healthy kernel is not refused
✓ an interpreter that cannot be probed FAILS LOUD rather than digesting a partial manifest

AssertionError: expected '0526e28116906fcc' not to be '0526e28116906fcc'
AssertionError: expected '0526e28116906fcc' to be 'dc82c4e868cf82a727860f1116cd0273353d4…'
AssertionError: expected '0526e28116906fcc' to match /^[0-9a-f]{64}$/u
```

**This is the strongest single fact in this slice.** The gate, run against the
pre-fix implementation, prints `0526e28116906fcc` — the exact value the frozen
BEFORE reproduction computes independently in
`before-weak-digest.json`. Two independently produced measurements agree on the
old value, and the gate rejects it.

Note the second and third messages: the digest is *shorter than the current
implementation's*, which is why the length assertion also fires. The gate is
therefore sensitive to BOTH the input set and the truncation, and it does not
depend on either alone.

## Reversion, verified

Both mutations were applied to the working tree with a scripted exact-match
replacement, then reverted by restoring a byte copy taken beforehand. After
reversion:

```
$ grep -n "slice(0, 16)" packages/dsh-ipython/src/kernel-plugin.ts      # no match
$ grep -n "broker_sha256: fileDigestOrNull" packages/dsh-ipython/src/kernel-plugin.ts
958:      broker_sha256: fileDigestOrNull(this.config.brokerScript ?? DEFAULT_BROKER_SCRIPT),
```

and the gate re-run GREEN, 5/5. A mutation left in the tree would have been far
worse than a red test, so the reversion is stated rather than assumed.

## What the mutations do NOT establish

1. They do not show the digest moves for a **changed Python or IPython version**.
   I did not install a second IPython or a second patch version of Python; the
   distribution-version inputs are covered by *reading* the probe's real values and
   cross-checking them against the interpreter, not by changing them. See the
   report's CLAIMS I AM NOT MAKING.
2. They do not show the **product** evicts a kernel. Mutation 2 was run against the
   service-level gate; the product path is measured separately and its own limit is
   stated in `BEFORE-AFTER.md`.
3. They do not establish that the probe cannot hang. That is measured SEPARATELY
   and really: a sleeping `sitecustomize.py` on `PYTHONPATH` hangs a real CPython
   before it runs `-c` source, and the service returns
   `KernelTransportError: the environment probe did not finish within 2000 ms` at
   2118 ms elapsed (standalone) / 2439 ms (as the test arm). That arm is the
   TIMER path, which the "cannot be probed" test does not reach -- that one takes
   the ERROR path. Both paths are now covered.
