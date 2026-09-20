# P11 / P1.4 — FINAL REPORT

```
SLICE: P1.4 — the Python environment identity is too weak to distinguish environments that differ
worktree/branch: D:\DSH\work\wt-p11 / wt/p11
commit(s): 56ee6c4 P11/P1.4: map the weak environment digest and archive the BEFORE reproduction
           5bfe913 P11/P1.4: replace the path-string environment digest with a bounded probe + manifest
           19345ad P11/P1.4: stop reporting the Python version as ipythonVersion (V5 11.2 naming)
           b1b7deb P11/P1.4: the ENV-DIGEST gate, and harden the probe's failure boundary
           24903b9 P11/P1.4: measure the environment identity through a REAL daily boot
           7f96238 P11/P1.4: close the timeout arm, and archive the BEFORE/AFTER and mutation pair
           8c06243 P11/P1.4: add the respelling arm, and record the pythonw escalation

REGIONS CHANGED (contended file, for merge-by-region):

 packages/dsh-ipython/src/kernel-plugin.ts
   ADDED, module level (imports unchanged in order; `readFileSync` added to an existing node:fs import):
     EnvironmentManifest                     :151-190
     DEFAULT_ENV_PROBE_TIMEOUT_MS            :199
     ENVIRONMENT_PROBE_SOURCE                :220-244
     ENVIRONMENT_MANIFEST_KEYS               :247-255
     canonicalManifestJson()                 :270-273
     fileDigestOrNull()                      :284-291
     ENVIRONMENT_PROBE_OUTPUT_CAP_BYTES      :294
     PROBE_TERMINATION_GRACE_MS              :297
     manifestFromProbeOutput()               :314-372
     EnvironmentStatus                       :525-537
   ADDED, config surface (KernelServiceConfig):
     dataClientScript / environmentProbeTimeoutMs / environmentManifest   :415, 423, 433
   ADDED, class:
     configuration()                         :696-698
   CHANGED, class (MY REGION):
     private resolvedManifest / manifestPromise fields   :~672-681
     reconfigure()                           :716-722   (now also clears the memo)
     identityFor()                           :730-737   (was SYNC, now ASYNC)
     resolveEnvironmentDigest()              :811-815   (REPLACES defaultEnvironmentDigest, DELETED)
     resolveEnvironmentManifest()            :825-840
     runEnvironmentProbe()                   :853-960
     manifestWithLocalFiles()                :973-979
     environmentStatus()                     :992-999   (NEW status surface)
     entryFor()                              :1013      (one line: `await this.identityFor(agent)`)
   NOT TOUCHED: runCell, preamble, drainUnattributed, ledger-open call site, kernelRoot()/DEFAULT_KERNEL_ROOT.

 packages/dsh-ipython/src/protocol.ts        KernelStatus :255-278  (ipythonVersion REMOVED; 5 named fields added)
 packages/dsh-ipython/src/broker.py          kernel_identity_fields() (NEW fn, inserted before class ProtocolError ~:277)
                                             status() uses it; "ipythonVersion" key REMOVED
 packages/dsh-ipython/src/p11-env-digest.test.ts               NEW (7 arms)
 packages/dsh-ipython/src/p11b-arm-probe.ts   :104 only — 2 `as unknown as` casts to fix a build break
                                              caused by my type (see UNRESOLVED UNKNOWN 4)
 packages/dsh-ipython/src/v3-spec-gates.test.ts :151-165 (consumed the renamed field)
 qualification/runners/p11-env-digest-driver.mjs               NEW
 qualification/runners/p11-env-digest-product.mjs              NEW
 qualification/runners/p11-env-digest-product.patch.yml        NEW
 qualification/results/P11-env/**                              NEW (8 files)
```

## LEAD: BEFORE / AFTER

A real content change to `broker.py` — the file the configured interpreter
actually executes — with everything else byte-identical.

| | BEFORE | AFTER |
|---|---|---|
| digest | `0526e28116906fcc` | `dc82c4e8…fd14` → `4e5611f5…00d9` |
| length | 16 hex (64 bits) | **64 hex (256 bits)** |
| inputs | interpreter **path string**, platform, arch | the 10-field V5 §11.2 manifest |
| sees a `broker.py` content change? | **NO** | **YES** |
| sees Python 3.14.0→3.14.1 at one path? | NO | YES |
| sees IPython 9→10 at one path? | NO | YES |
| sees a changed `ipykernel`/`jupyter_client`/`pyzmq`? | NO | YES |
| sees a changed bridge Python client? | NO | YES |
| sees a respelling of the same interpreter path? | **YES (defect)** | **NO (fixed)** |

The AFTER values are measured through a **real `daily` boot's own `ctx.ipython`**,
not a test context. The BEFORE value is the output of the frozen pre-edit
expression, and — independently — the value the gate printed when I put the old
expression back during mutation testing. Two independent measurements agree.

## WHAT CHANGED, per file

- **`kernel-plugin.ts`** — `defaultEnvironmentDigest` (a hash of a path string)
  is **deleted** and replaced by a bounded one-shot Python probe at identity
  resolution plus the three local-file hashes, digested as canonical JSON.
  `identityFor` became async; `reconfigure` clears the memo; `environmentStatus()`
  and `configuration()` were added as the status surface.
- **`broker.py`** — new `kernel_identity_fields()` returns V5 §11.2's five names
  from the `kernel_info_reply` the kernel actually sent. `status()` no longer
  publishes `ipythonVersion` (which carried the *Python* version).
- **`protocol.ts`** — `KernelStatus.ipythonVersion` removed; the five named
  fields added. Removed rather than aliased, because an alias would preserve a
  field that is wrong by construction.
- **`p11-env-digest.test.ts`** — the V5 §18 gate, 7 arms.
- **`qualification/runners/p11-env-digest-*.mjs`** — the composition-tier probe,
  driver and overlay, using the shared `materialiseOverlay` helper so the probe
  row names THIS tree's file (cross-tree code execution is a recorded hazard here).

## SOURCE_FACTS

- `kernel-plugin.ts:441-446` at base — the old digest expression, verbatim.
- `kernel-plugin.ts:467-473` — the only consumer that acts on the digest; throws
  `…the kernel must be evicted`. Its message names both digests.
- `kernel.ts:522-527` — `assertIdentity`, the second equality check.
- `kernel.ts:226` — `argv: [pythonExecutable, brokerScript]`; this is why
  `broker.py` is the right file to hash.
- `broker.py:746-781` at base — `status()`, and `:770` where the field named
  `ipythonVersion` was populated from `language_info.version`.
- `ipykernel/kernelbase.py` `kernel_info` — `implementation`,
  `implementation_version`, `language_info`, `protocol_version`.
- `qualification/results/V3-ipython/GATES.md:141` and
  `run-v3-spec-gates.txt:5` — the mislabelling was ALREADY filed; this closes a
  recorded finding rather than a new one.
- `packages/dsh-ipython/src/sec-gates.test.ts:1691` and
  `data-plane.test.ts:454` read/mount my file; both re-run green.

## TEST_RESULTS

```
node helpers/typecheck.mjs                                        -> PASS, 2 packages, 32 files, 0 errors
  (identity: this worktree, tsc 6.0.3 from the pinned checkout, tsconfig.check.json)
cd packages/dsh-ipython && node node_modules/vitest/vitest.mjs run src/p11-env-digest.test.ts
                                                                  -> 7 passed / 0 failed
… run src/service.test.ts                                         -> 9 passed / 0 failed
… run src/v3-spec-gates.test.ts                                   -> 12 passed / 0 failed
… run src/lifecycle.test.ts                                       -> 15 passed / 0 failed
… run src/r5-restart-epoch.test.ts                                -> 1 passed / 0 failed
… run src/r5-product-bridge.test.ts                               -> 30 passed / 0 failed
cd packages/dsh-daily-work && … run src/sec-gates.test.ts         -> 46 passed / 0 failed
… run src/data-plane.test.ts                                      -> 82 passed / 0 failed
DSH_HOME=D:/DSH/home/p11 node qualification/runners/p11-env-digest-driver.mjs
                                                                  -> booted true, digestIsFullSha256 true,
                                                                     digestMovedWithFileContent true,
                                                                     brokerRestoredByteIdentical true, error null
```

One file at a time, per the CPU discipline. No full-suite run.

## BEFORE/AFTER artifacts

`qualification/results/P11-env/` — `BEFORE-AFTER.md` (the pair, the AFTER manifest
verbatim, reproducing commands), `MUTATION-TESTING.md` (both mutations with exact
red output), `before-weak-digest.mjs`/`.json` (the frozen old expression, including
a real on-disk mutation), `composition-tier.json` (the AFTER value from a real
boot), `composition-tier.probe.json`, `STEP1-SOURCE-MAP.md`.

## PRODUCT REACHABILITY

The shortest real path: **`dsh --profile daily` boot → the profile's own
`dsh-ipython` host row mounts `KernelService` → the first `ipython` tool call →
`KernelService.runCell` → `entryFor` → `identityFor` → `resolveEnvironmentDigest` →
the probe.** MEASURED, not inferred: `qualification/runners/p11-env-digest-driver.mjs`
boots the real profile and reads the digest out of the boot's OWN `ctx.ipython`,
obtaining `dc82c4e8…` and watching it move to `4e5611f5…` across a real
`broker.py` mutation. The `ipython` tool is reachable from the model (the catalog
is measured at 27 names with `ipython` present).

## PASS / FAIL / BLOCKED / NOT_RUN

- **PASS** — `ENV-DIGEST` arm 1: a changed local file (the file the interpreter
  executes) moves the digest and refuses a live kernel. Measured at service tier
  AND through a real boot.
- **PASS** — the naming trap: `ipythonVersion` removed; the five V5 §11.2 names
  are live, and the IPython version (`9.16.1`) is distinct from the Python
  version (`3.14.3`), measured through a real kernel.
- **PASS** — bounded probe: a REAL hanging CPython returns
  `KernelTransportError: … did not finish within 2000 ms` at 2118 ms (standalone)
  / 2439 ms (as a test). Fails loud; no partial manifest; the failure is not
  cached, so a transient failure is retryable.
- **PASS** — the respelling property: four spellings of one interpreter path give
  one digest. This is the arm the OLD digest failed.
- **PASS** — control arms: the same environment twice gives the same digest; an
  unrelated config change (`root`) does not move it.
- **NOT_RUN (with reason)** — a changed **Python patch version**, a changed
  **IPython version**, and changed **`ipykernel`/`jupyter_client`/`pyzmq`** were
  NOT produced by installing anything. The fields are proven to be real values
  read from the interpreter and to be digest inputs; the *version-change* event
  itself was not staged. See CLAIMS I AM NOT MAKING.
- **NOT_RUN (with reason)** — PRODUCT eviction. `environmentStatus()` deliberately
  does not start a kernel, so the composition-tier probe cannot show a kernel
  being refused; the refusal is measured against a real kernel at service tier.
  The product's kernel-restart policy belongs to the host, not to this slice.
- **BLOCKED, escalated** — the `pythonw.exe` arm. Measured by P11b as MOVING.
  It is a consequence of a field V5 §11.2 mandates, so closing it would change a
  spec-mandated input. Needs root's ruling; not pre-empted.

## UNRESOLVED UNKNOWNs

1. **Does the PRODUCT evict on a changed digest?** The service REFUSES (throws);
   whether the host catches that and evicts, or surfaces it, is outside my region
   and unmeasured. A digest that moves proves the identity changed, not that
   anyone acted on it.
2. **`data_client_sha256` is `null` in the live deployment.** The `dsh.data`
   client lives in `dsh-daily-work`, which this package must not import to
   compute its own identity, so the path is host-supplied and no host supplies
   one. The FIELD is proven wired (a test drives it with a host-supplied path),
   but in the shipped profile that input is absent. Closing it needs whoever owns
   the profile to set `dataClientScript`.
3. **The probe's cost on a cold filesystem.** 0.136 s measured warm. The 10 s
   default is ~70x that, but no cold-cache or antivirus-loaded measurement was
   taken.
4. **`p11b-arm-probe.ts` was committed by another writer with 2 type errors**
   (`TS2352`) caused by my `EnvironmentManifest` having no index signature. That
   broke the package BUILD. I fixed it with the compiler-suggested
   `as unknown as` (2 casts, no behaviour change) and flagged it here rather than
   editing their file silently. The escape-hatch baseline is unchanged at 3.
5. **A composition-tier run needs `lib/` rebuilt first.** My first probe run
   reported a FALSE NEGATIVE ("no `environmentStatus()`") because the boot loaded
   a stale `lib/` — the G-SEAM-29/36 trap, hit by me. Recorded in
   `BEFORE-AFTER.md`. If the integrator's merge process does not rebuild, the same
   false negative is available to the next reader.

## CLAIMS I AM NOT MAKING

1. **I did NOT install a different IPython, a different Python patch version, or
   a different `ipykernel`.** The arms for those changes are established by
   (a) reading the real versions from the interpreter, (b) cross-checking them
   against the same interpreter through an independent `python -c`, and (c) the
   "every manifest field is an input" arm proving the digest covers the manifest.
   That is NOT the same as having observed the digest move across an actual
   version upgrade, and I am not claiming it.
2. **A digest proves the ENVIRONMENT CHANGED, not that the kernel was correctly
   evicted.** The service-level refusal and the non-replacement are measured; the
   product's eviction policy is not.
3. **`data_client_sha256: null` is not coverage.** The third local-file field is
   wired and tested, but in the shipped profile no host supplies the path, so that
   input contributes nothing to the live digest.
4. **The composition-tier probe does not drive a model turn** and does not start a
   kernel. It measures the identity the boot's service would use.
5. **`pythonw.exe` is not fixed.** Two distinct executables in one directory give
   two digests, by design of a mandated field. My judgement that this is
   defensible is an INFERENCE, not a measurement.
6. **The `p11b-arm-probe.ts` type fix is a build repair, not my slice.** I did not
   review that file's logic.
7. **I did not run the full suite** (CPU discipline). The 8 files above are the
   ones that read, mount, or consume my regions.
8. **`EnvironmentStatus.manifest` returns the live object, not a frozen copy.**
   A caller that mutated it would not change the digest (which is already
   computed) but could misread the manifest. No caller does this today.
