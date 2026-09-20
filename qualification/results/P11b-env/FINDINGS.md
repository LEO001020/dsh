# P11b — independent verification of the P11 environment-identity slice

**Verdict: the slice is DELIVERED and I independently reproduced its core claims.
One acceptance arm does not hold, and it is the one the spec itself specifies.**

worktree `D:\DSH\work\wt-p11`, branch `wt/p11`.
Written by writer P11b, dispatched to replace "writer P11, which produced zero
commits". **That premise was false and is the first finding.**

---

## 0. FINDING 1 — the dispatch premise was false; P11 was alive

`RUNTIME_FACT`. P11 was not dead. It was working in this worktree the whole time,
and it produced the slice. Measured:

| time | event |
|---|---|
| 21:01:50 | my salvage commit `2def272` |
| 21:04:34 | P11 `5bfe913` STEP 2 |
| 21:06:30 | P11 `19345ad` STEP 4 |
| 21:10:33 | P11 `b1b7deb` STEP 3 |
| 21:19:21 | P11 `24903b9` composition tier |

Evidence that it was live rather than a fast predecessor: `kernel-plugin.ts` and
`broker.py` were being written **while I read them** (`broker.py` mtime moved
21:09:04 → 21:09:23 → 21:09:39 → 21:10:09 while its md5 stayed constant — the
signature of P11's own mutation arm mutating and restoring the file). New
untracked files appeared at 21:16:41, 21:17:28, 21:17:37 and 21:18.

**Consequence, and why I did not implement STEPs 2–4 myself.** A second writer in
the most contended file of the round, whose owner was live in it, is the
lost-update the brief's contention map exists to prevent. I stood down from
edits to `kernel-plugin.ts`, `broker.py` and `protocol.ts` and spent the slice on
independent verification instead, which is the thing a second agent can add and
the first agent cannot.

**ONE INCIDENT, DISCLOSED.** To check that P11's gate is not vacuously green I
reverted the digest expression to the old one, ran the gate, and restored from a
backup. During that window P11 wrote a new method (`configuration()`) into the
same file. My restore was from a pre-write backup, so **I briefly clobbered that
edit**. I detected it immediately: the restored file was missing `configuration()`
while P11's new runner `p11-env-digest-product.mjs:132` already depended on it. I
verified the file's current state and it **does** contain `configuration()` and
the new digest line, and P11's subsequent commits (`24903b9`) built and ran
against it successfully — so the edit was re-applied by P11 or survived. I am
recording this because it happened, not because it is resolved by luck: **a
mutation arm run against a file with a live owner is unsafe, and I will not do it
again.**

---

## 1. What P11 delivered (verified by reading, not by trusting the messages)

`SOURCE_FACT`, all in `packages/dsh-ipython/src/kernel-plugin.ts`:

- `EnvironmentManifest` interface (`:150`) — the ten V5 §11.2 fields.
- `ENVIRONMENT_PROBE_SOURCE` (`:219`) — one `python -c` using `importlib.metadata`,
  each field individually guarded, printing one line of sorted JSON.
- `canonicalManifestJson()` (`:270`) — keys sorted, no insignificant whitespace.
- `resolveEnvironmentDigest()` (`:793`) — `sha256(canonicalManifestJson(manifest))`,
  **full 64 hex**, not the old 16.
- `resolveEnvironmentManifest()` (`:807`) — cached, failures NOT cached.
- `runEnvironmentProbe()` (`:835`) — bounded, spawn inside the failure boundary.
- `manifestWithLocalFiles()` (`:955`) — the three file hashes.
- `environmentStatus()` (`:983`) — status surface, does not start a kernel.
- `identityFor()` (`:712`) — now `async`.
- `reconfigure()` (`:698`) — discards the cached manifest.

---

## 2. FINDING 2 — the acceptance property holds for arm 1, and for the spelling half of arm 2, but NOT for `pythonw.exe`

`RUNTIME_FACT`. Measured through the real `KernelService.environmentStatus()`, not
by recomputing the hash. Raw: `qualification/results/P11b-env/after-arm-probe.json`.

| arm | BEFORE (old expression) | AFTER (manifest digest) | verdict |
|---|---|---|---|
| 1. different `broker.py` (different bytes) | `0526e28116906fcc` **both arms** | `dc82c4e8…` → `09cc3fbc…` | **PASS — moves** |
| 2. backslash spelling of one file | `9d54eebf1cf721d5` | `dc82c4e8…` **same** | **PASS — stable** |
| 2. upper-case spelling of one file | `d3195189b50671d1` | `dc82c4e8…` **same** | **PASS — stable** |
| 2b. `pythonw.exe` vs `python.exe` | `0526e28116906fcc` / `f3013b4585d0ed18` | `dc82c4e8…` / `ccb6f823…` | **MOVED — arm does not hold** |
| control: different kernel `root` | unchanged | unchanged | **PASS** |

The manifest diff for arm 2b names exactly one field:
`sys_executable_realpath`. Every other input — all four package versions and all
three file hashes — is byte-identical between the two binaries.

**This is a spec consequence, not a missed normalisation, and the distinction
matters for how it should be closed.** V5 §11.2 *requires* the field
`sys_executable_realpath`. `os.path.realpath` resolves symlinks, junctions and
spelling; it does **not** resolve between two *different executables* in one
directory. So under the field the spec mandates, `pythonw.exe` and `python.exe`
are two environments. Root's `G-SEAM-80` arm 2 ("arm 2 must not move") was
measured against the OLD digest, where the movement was a defect for a different
reason — the old digest was hashing a *config string* that a user could respell,
which is fixed. Whether the `pythonw` pair must also collapse is a question about
the spec, and I am not deciding it silently: **it needs root's ruling.**

`INFERENCE` (flagged as such): the two binaries are genuinely different files with
different bytes and different console-subsystem behaviour, so treating them as
different environments is defensible. But a Windows user who sets `DSH_PYTHON` to
`pythonw.exe` gets a different kernel slot for what they experience as one
environment — the same *user-visible* failure mode as the respelling defect, minus
the reachability. `PROJECT_FACT`: I grepped every `*.yml`/`*.json`/`*.mjs`/`*.ts`
outside `node_modules` and the only `pythonw` references in the tree are in my own
probe, so **nothing shipped sets it**. The arm is therefore currently
unreachable in production and is a spec question rather than a live defect.

---

## 3. FINDING 3 — P11's gate is real, not vacuously green (mutation-tested)

`TEST_RESULT`. P11's `p11-env-digest.test.ts` passes **5/5** on the current tree
(`node node_modules/vitest/vitest.mjs run src/p11-env-digest.test.ts --pool=forks`).

I did not accept that as evidence, because a test written after a fix passes for
many reasons. I replaced the new digest body with the old expression and re-ran:

```
Tests  3 failed | 2 passed (5)
  expected '0526e28116906fcc' to match /^[0-9a-f]{64}$/u
```

**The failure prints `0526e28116906fcc` — the exact value root's BEFORE
measurement recorded.** That is the RED half, reproduced independently. Mutation
reverted, file restored, gate green again.

`PROJECT_FACT`: the gate covers arm 1 thoroughly (real `broker.py` mutation, the
live kernel refused with the same epoch, the file restored and the session
recovering) and asserts every manifest field is an input. It contains **no arm for
arm 2 at all** — `grep -c pythonw` over it returns 0, and there is no spelling arm
either. The slice's acceptance property has two halves; the shipped gate measures
one.

---

## 4. FINDING 4 — STEP 4 naming verified live, but its cited evidence was BEFORE

`SOURCE_FACT`: `broker.py:770` previously published `"ipythonVersion": version`
where `version` came from `language_info.version` (`:760`) — the Python version.
Now `kernel_identity_fields()` (`broker.py:277`) returns V5 §11.2's five names and
`ipythonVersion` is **removed**, not aliased. `protocol.ts:276-284` carries the five
fields and documents the removal.

`TEST_RESULT`, measured by me (`qualification/results/P11b-env/step4-live-status-naming.txt`):

```json
{"kernelImplementation":"ipython","kernelImplementationVersion":"9.16.1",
 "languageName":"python","languageVersion":"3.14.3","protocolVersion":"5.3"}
```

Five distinct values; `kernelImplementationVersion` is the **IPython** version and
`languageVersion` is the **Python** version. The old field carried `3.14.3` under
the name `ipythonVersion`, which is the mislabelling `GATES.md:141` filed.

**A caveat the commit message does not state.** The transcript it cites,
`qualification/results/V3-ipython/run-v3-spec-gates.txt:5`, still contains
`"ipythonVersion":"3.14.3"` — it is BEFORE evidence and was not regenerated. The
claim is true; the cited artifact does not support it. My run above is the AFTER
pair.

---

## 5. Composition tier — PASS, after a stale-`lib` false failure

`TEST_RESULT`. P11's first composition run (`composition-tier.json`, 21:17:45)
**failed**: `the boot's ipython service has no environmentStatus()`. That was
**not** a product defect: the profile links `dsh-ipython` to this worktree, and
`lib/kernel-plugin.js` had not been rebuilt yet (rebuilt 21:18:12, 21:19:12). The
re-run at 21:19:21 passed:

```
digestIsFullSha256: true          digestChars: 64
configuredByHost: false           (manifest-derived, not host-supplied)
digestBeforeMutation: dc82c4e868cf82a727860f1116cd0273353d402ecb8a082a16e56ec7e247fd14
digestAfterMutation:  4e5611f56c6348851add7c7b3e1c496f509a3470e41fb5fc841e56d89ac900d9
digestMovedWithFileContent: true  brokerRestoredByteIdentical: true
```

`PRODUCT_FACT`: a **real `daily` boot** now derives its environment identity from
the manifest. This is the F2-shaped question — does the PRODUCT do it, not just
the tests — and the answer is measured yes.

---

## 6. OPEN ITEMS I am leaving, with the evidence a closer needs

1. **Arm 2b (`pythonw.exe`)** — section 2. Needs root's ruling on whether V5 §11.2
   intends it to collapse. If it must, the fix is *not* in the digest: it is a
   decision about what `sys_executable_realpath` means, and the honest options are
   (a) accept it, (b) add a normalisation the spec does not ask for and say so.
2. **`data_client_sha256` is `null` in every real boot.** `SOURCE_FACT`: nothing in
   `packages/dsh-ipython/cordis.patch.yml` or `profiles/daily-candidate/cordis.patch.yml`
   sets `dataClientScript`, so V5 §11.2's third hash is never populated in
   production — only in P11's test, which supplies the path itself. The field is
   correctly *wired* and honestly `null`; the **integration** that would fill it is
   not done. `INFERENCE`: the owning package is `dsh-daily-work`, so this belongs
   to whoever wires the data plane, not to P11.
3. **`bridge_python_client_sha256` hashes the TS template, not a file.** `SOURCE_FACT`:
   `bridgeClientDigest()` (`bridge.ts:1667`) hashes `PYTHON_CLIENT_SOURCE`, and
   `bridge.ts:945` writes that same string to disk. So it is a hash of the *source
   of truth* — correct, and deliberately not a hash of a generated path (a
   generated file's path is not stable and its bytes are the template's). Worth
   stating explicitly because it is the one field that is not a file read.
4. **`v3-spec-gates.test.ts` IPY-01's archived transcript is stale** — section 4.
5. **`environmentStatus()` is not surfaced in any doctor/status output** that I
   found. It exists on the service; a host reader would have to call it. P10 owns
   the ledger half of the status surface (`bridgeLedgerDurable`), so if the two
   are to appear together, that is a one-field coordination, by name, not a second
   surface.

---

## 7. Claims I am NOT making

- I did **not** write STEPs 2, 3 or 4. P11 did. My commits are verification
  instruments and evidence, listed in the report.
- I did **not** prove the product evicts a kernel in production. The gate shows
  `entryFor` refusing with `the kernel must be evicted`; the composition probe
  shows the digest moves. The eviction path itself was exercised at code-path
  tier, not measured through a real model-visible cell.
- I did **not** install a second IPython, upgrade any distribution, or test a
  genuinely different package set. Every arm varies a path, a spelling or a file
  this repo owns. "IPython 10 changes the digest" is **UNKNOWN** by measurement —
  it follows from `importlib.metadata` reading the installed version, which is
  `INFERENCE`, not a measured arm.
- I did **not** measure the `pythonw` reachability question in section 2.
- I did **not** verify `p11-env-digest-driver.mjs` / `-product.mjs` beyond reading
  them and reading their archived output; I re-ran no composition boot myself
  (booting a second profile is heavy load and another writer was active).
- The `0526e28116906fcc` value in section 3 is from **my** mutation run and
  independently matches root's BEFORE; I did not re-run root's six-arm probe.
