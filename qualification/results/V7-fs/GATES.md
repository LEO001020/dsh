# V7 — FILESYSTEM family (FS-01..FS-06): measured gates

**Deployment identity:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
**Build measured against** (`VERDICT.json` → `build`):

| package | lib files | sha256 of the concatenated built `lib/*.js` | `lib` newer than `src`? |
|---|---|---|---|
| `dsh-daily-work` | 32 | `a9a8369abe7aed0036703e6aab3fc4ccbfdca57a7829eb662e71d22a036130e4` | yes (no stale module) |
| `dsh-ipython` | 8 | `04057fcad447751f5e1917550a64398cc7d63e7db47b3c5fe8a3c396a526bfc5` | yes (no stale module) |

**Installed composition:** `5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4`,
equal to the repository copy (`composition.isCurrent: true`), installed FRESH by the driver
(`plugin install` exit 0). Every home installs through a `link:`, so a boot executes the
built `lib/`, never `src/` — which is why the rebuild/staleness check is recorded above
rather than assumed.

**Boot:** one host at a time, harness-chosen port (the recorded run bound `8270`),
`portReleased: true`, `timedOut: false`, activation warnings `[]`, probe error `none`.
The result names the home it came from (`readResult()` guard, `presetRoots` contains
`D:/DSH/home/v7-fs`), so it cannot be another agent's result.

**Verdict:** `qualification/results/V7-fs/VERDICT.json` — **47/47 checks pass**.

---

## 1. The label collision, stated before the verdicts

`packages/dsh-daily-work/src/durability-advanced.test.ts` has a describe block named
`T9-C: FILESYSTEM gates FS-01..FS-06`, and `verification-gates.test.ts` has `FS-06` cases.
**Those labels predate this spec and their subjects do NOT match it.** Mapping by label
would have filed the wrong evidence for every case, so each verdict below is mapped by
ORACLE. [measured: read the spec's `oracle` field against each test's assertions]

| pre-spec label | what that test actually measures | spec case with the same id |
|---|---|---|
| T9-C `FS-01` | atomic write; an aborted write leaves the original | **FS-01** write boundary DISCLOSURE |
| T9-C `FS-02` | stale version rejected with `FS_STALE_VERSION` | **FS-02** read boundary DISCLOSURE |
| T9-C `FS-03` | concurrent same-target mutations serialized | **FS-03** one path, four routes, one world |
| T9-C `FS-04` | exact edit; ambiguity refused; not-found | **FS-04** link and rename, per vector |
| T9-C `FS-05` | line endings preserved through an `edit` | **FS-05** structured tool semantics |
| T9-C `FS-06` | raw-Python mutation visible to the verifier | **FS-06** workspace vs store-owned artifacts |
| `verification-gates` `FS-06` | raw-Python mutation vs the candidate/HEAD comparison | **FS-06** (supporting, same conflation theme) |

The T9-C block is therefore real evidence for this family's **FS-05** (edit semantics) and
supporting evidence for the CORRECTNESS of the mounted backend that FS-01..FS-06 lean on —
but it is not evidence for FS-01/02/03/04/06, whose oracles it never touches. The V7 boot
probe measures those oracles directly.

---

## 2. The provider swap, proved by a CONTROL EXPERIMENT

The swap (profile DIFFERENCE 3: `fs-sandbox` disabled, `fs-local` inserted) is not argued
from the patch text. The **same probe binary** was run against the post-swap composition and
against a control composition with the swap reverted, so the only variable is the two
provider rows. Source: `qualification/results/T2-fs/VERDICT.json` and
`qualification/results/T2-fs/CONTROL.json`. [measured]

| observation | swapped (`fs-local`) | control (`fs-sandbox`) |
|---|---|---|
| `providerClassName` | `LocalFileSystem` | `SandboxedFileSystem` |
| `sandboxClassInPrototypeChain` | `false` | `true` |
| **write OUTSIDE the workspace** | **succeeds** | **denied** |
| `escalationFieldsAdvertised` on `write`/`edit` | `{write:[], edit:[]}` | `{write:["sandbox_permissions","justification"], edit:[same]}` |
| `toolCount` | 27 | 27 |
| inactive entries | none | none |

So the fence **was** blocking writes before the swap and is not after it. The second row
follows from the first: `tool-fs` advertises the escalation parameters only when
`ctx.fs.sandboxMode` is defined (`packages/fs/tool-fs/src/sandbox.ts:44-45`), and the local
backend has no `sandboxMode`. `sandboxPolicyDefaultMode` was `workspace-write` in the swapped
run, so the fence was live and this is a real behavioural change rather than a no-op under an
already-permissive mode.

**The swap is narrower than it looks.** `SandboxedFileSystem extends LocalFileSystem`
(`packages/fs/fs-sandbox/src/index.ts:55`, importing it at `:30`, with
`super.writeText`/`super.editText` at `:87`/`:108` and no line-ending code of its own). The
sandbox layer adds only `checkedTarget(...)` — the containment check — around inherited
behaviour. So read, write, edit, diff, versioning and line-ending semantics are `fs-local`'s
in BOTH compositions and cannot have changed. Recorded as **G-SEAM-32**. [read in source]

---

## 3. FS-01 — the write boundary is disclosed, not claimed

**Oracle:** the write SUCCEEDS and the record states plainly that no filesystem write
confinement is claimed under trusted-local. Presenting a write boundary the mode does not
provide, or describing the deployment as confined, is NOT PASS.

**Command:** `node qualification/runners/v7-fs-driver.mjs` (repo root)
**Raw output:** `qualification/results/V7-fs/boot.json`, `.../transcript.txt`, `.../VERDICT.json`

**Measured [measured]:**

| fact | value |
|---|---|
| write outside the session workspace, through the native `write` tool | `isError: false` |
| the file exists outside the workspace afterwards | `true` |
| `ctx.fs.sandboxMode` (the backend's own capability fact) | `undefined` → the mounted backend does not confine |
| `fsProvider` | `LocalFileSystem` |
| escalation fields on `write` / `edit` schemas | `[]` / `[]` — no fence to escalate past |
| lock `trust_model_statement` says no write confinement is claimed | `true` (regex on the file) |
| spec `trust_model.explicitly_not_claimed` lists filesystem write confinement | `true` |

**STIMULUS SUBSTITUTION, recorded rather than glossed.** The stimulus names `pwsh` as the
vector. `pwsh` is **absent from the daily preset by architecture** — measured in this same
boot (`toolFace.pwshPresent: false`, and the deployment's own guard reports
`surface.pwsh-absent: ok, observed: "pwsh is absent"`; CMP-13 requires its absence). So the
named vector does not exist in this deployment and cannot be used. The property was measured
through the routes that ARE mounted: the native `write` tool (above) and raw Python (FS-06).
A reader who requires the literal `pwsh` route must record this case NOT_RUN; the oracle's
substance is established on the mounted routes.

**VERDICT: PASS**, with the following named defect carried rather than folded in.

### The disclosure contradiction (G-SEAM-33) — measured, and it is a real defect

The deployment's own self-check, read from the live `ctx.noSandboxContract` service in this
boot, reports **2 violations of 13 checks**:

| check | observed | ok? |
|---|---|---|
| `sandboxPolicy.defaultMode` | `'workspace-write'` — *"which CONFINES"* | **FAIL** |
| `ptcRuntime.sandboxMode` | `mounted, sandboxMode: 'workspace-write'` | **FAIL** |
| `fs.provider` | `LocalFileSystem (sandboxMode: undefined (does not confine))` | ok |
| `shell.provider` | `PwshLocalExecutor (sandboxMode: undefined)` | ok |
| `surface.escalation-parameters` | `none of 27 visible tools advertise sandbox_permissions/justification` | ok |
| `session.override` | `overrideOf = undefined; resolve() = 'workspace-write'` | ok |

The product therefore tells itself, in its own words, that the graph is **not** the intended
trusted-local graph. Two consequences are recorded here because they bear on this oracle:

- `sandboxPolicy.defaultMode` is `workspace-write`, **not** `danger-full-access`. The fs
  backend provides no confinement while the policy service still states a confining default,
  and PTC still confines. `modeSource` is `unobservable` (an honest limit the service itself
  documents: a schema default of `read-only` and an explicit `read-only` are the same value).
- The disclosure documents (lock + spec) are consistent with the fs behaviour; the stale
  policy value is a config defect that the product's own guard detects and reports.

**The judgment call is stated so a reader can overturn it.** I read the oracle's
"presenting a write boundary the mode does not provide" as being about a deployment that
*claims* confinement it does not have; here the fs backend claims none and provides none, and
the confining value belongs to a different service that the product flags as a violation. If
a reader holds that a stale confining `defaultMode` *is* such a presentation, then FS-01 is a
**FAIL** on the strength of the two violations above, and the measurement to support that
reading is in `boot.json → fs01.contractReport`. I did not edit the oracle or the config.

---

## 4. FS-02 — the read boundary is disclosed, not claimed

**Oracle:** both reads SUCCEED and the record states that reads are not confined. A read-only
mount must not be presented as secrecy, and a documentation claim of read isolation is NOT PASS.

**Command / raw output:** as FS-01 (`boot.json → fs02`, `VERDICT.json → fs02`).

**Measured [measured]:**

| fact | value |
|---|---|
| read of a file OUTSIDE the workspace via the native `read` tool | `isError: false` |
| the same file read via a real `python.exe` child process | exit 0 |
| both routes reached the **same bytes** (sha256 compared) | `true`, `dbe5b6653550debf47ccdb6762e97aaa3db164753d6fdc42a673b00b531c21a2` |
| `explicitly_not_claimed` lists host-secret read isolation | `true` |

Comparing DIGESTS rather than an error field is what makes this a measurement: a read that
"did not error" but returned different bytes would not establish the oracle.

**VERDICT: PASS.**

---

## 5. FS-03 — one path string resolves to one file in one world

**Oracle:** all four routes resolve in the SAME execution world and reach the same file; the
record names that world. Any mixed resolution is NOT PASS.

**Command / raw output:** as FS-01 (`boot.json → fs03`, `VERDICT.json → fs03`).

The path is a canary file in the session workspace. Each route is a different mechanism, and
the comparison is by sha256 so "same file" is not an inference from a similar-looking string.

| route | mechanism | reached the canary? |
|---|---|---|
| native `read` | the `fs` service | yes |
| native `grep` | ripgrep child process | yes |
| spawned process | the real mounted `ctx.shell` executor, `PwshLocalExecutor`, `sandboxMode: undefined` | yes — `Get-FileHash` returned `71154cc230443be8bcfaa52fb933901ff06396ea936d948a578b8c10ab0671cb` |
| Python cell | a real `python.exe` child process | yes — same digest |

All four digests equal the independently computed file digest. The record names the world:
`ctx.dailyData.executionWorld = "local"`, and the deployment's own guard reports
`ssh.absent: ok, "ssh: absent; sshSubprocess: absent"` and `wsl.absent: ok` — so there is no
second world for a path to be mis-resolved against.

**VERDICT: PASS.**

**A probe defect found and fixed here, recorded because it is the same class as T2's.**
The first run compared `String(run.stdout)` and measured `"[object Object]"`, failing this
check while the shell had answered correctly. `ShellRunResult.stdout` is a `CollectedOutput`
— `{ text, truncated, spillPath? }` (`packages/subprocess/subprocess/src/types.ts:22-29`) —
not a string. Same shape as T2's `FsError.code` mistake (routing on the message instead of
the code). The product was never at fault in either case.

---

## 6. FS-04 — link and rename, recorded PER VECTOR

**Oracle:** each vector's observed outcome is recorded separately, and a vector that is NOT
refused is reported as a FINDING rather than folded into a green. The correctness half must
hold in every case: no data corruption, and no operation silently acting on a different file
than the caller named.

**Command / raw output:** as FS-01 (`boot.json → fs04`, `VERDICT.json → fs04`).

| vector | refused? | outcome (recorded separately) |
|---|---|---|
| **symlink** escape: a link in the workspace → a target outside, then a write THROUGH the link | **NOT REFUSED** | the write followed the link and mutated the target outside the workspace. **FINDING.** |
| **hardlink** creation: an outside source linked into the workspace, then a write through it | **NOT REFUSED** | the link shares the inode, so the write inside the workspace mutated the outside file. **FINDING.** |
| **cross-boundary rename** via raw Python | **NOT REFUSED** | the file moved across the boundary. Content **INTACT** (sha256 before == after). **FINDING.** |

**The correctness half holds in all three cases [measured]:** no data corruption anywhere
(the rename's digest before and after are equal), and no operation acted on a file other than
the one the caller named. The symlink case writes the link's TARGET, which is what a symlink
*means* at the OS level — the caller named a link whose content IS the target, so this is the
documented semantic and not a silent mis-resolution. The native `read` tool then read the
moved file at its NEW path and saw the real content, so the rename is visible to the tool
layer rather than leaving a stale identity behind.

**VERDICT: PASS.** The three non-refusals are the finding, not a green: under trusted-local
there is no containment to refuse them, and each is recorded individually as this oracle
requires. A reader must not read these three rows as "the boundary held".

**Three probe defects found and fixed here, recorded because each would have produced a
FALSE FINDING in the green direction.** All three vectors initially reported `REFUSED` with
`FS_NOT_OBSERVED` — "file has not been read". That refusal comes from the **observation
policy** (read-before-mutate), which has nothing to do with containment: reporting it as
"REFUSED" would have claimed the boundary held while the containment question was never put
to the system. The probe now reads each target first, and a driver check asserts the mutation
actually reached the system (`code !== 'FS_NOT_OBSERVED'`) so this cannot silently return.

---

## 7. FS-05 — structured file tools keep their documented semantics

**Oracle:** pagination returns the requested window, the exact replacement applies once, and
the ambiguous case is refused rather than guessing. These tools remain usable beside the
Python path rather than being degraded to decoration.

**Commands and raw output:**

- `node qualification/runners/v7-fs-driver.mjs` → `boot.json → fs05`, `VERDICT.json → fs05`
- `cd packages/dsh-daily-work && node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/durability-advanced.test.ts -t "T9-C" --maxWorkers=1 --no-file-parallelism` → `t9c-tests.txt`
- `node qualification/runners/t2-probes/crlf-probe.mjs` → `crlf-probe.json`
- `node qualification/runners/t2-probes/sandbox-crlf-probe.mjs` → `sandbox-crlf-probe.json`

**Measured through the real model-facing tools [measured]:**

| assertion | measured result |
|---|---|
| `read` with `offset: 100, limit: 5` on a 400-line file | lines **100, 101, 102, 103, 104** — not 99, not 105, not the head. `windowIsExact: true` |
| exact unique replacement `beta` → `BETA` | applied once; on-disk content `alpha BETA gamma\n` |
| AMBIGUOUS replacement (`x` three times, `replace_all` unset) | **REFUSED**, `code: FS_AMBIGUOUS_EDIT`; content unchanged `x x x\n` |
| absent literal | **REFUSED**, `code: FS_EDIT_NOT_FOUND`; content unchanged |

**The T9-C block: 6/6 passed** (`t9c-tests.txt`, 26 skipped by the `-t` filter, `Test Files 1
passed`, exit 0) — atomic publication, stale-version refusal, per-target serialization, exact
edit semantics, line endings, and the raw-Python visibility case.

### The CRLF contract, measured in BOTH directions

This is the correction of a wrong EXPECTATION, not a backend bug, and the measurement is the
reason to believe it. Raw hex of the bytes on disk, from `crlf-probe.json`:

| operation | content given | bytes on disk (hex) | meaning |
|---|---|---|---|
| `editText` on a CRLF file | LF-normalized internally | `6f6e650d0a54574f0d0a74687265650d0a` | **CRLF preserved** |
| `writeText` LF content onto a CRLF file | `x\ny\nz\n` | `780a790a7a0a` | LF lands as LF |
| `writeText` CRLF content onto a CRLF file | `x\r\ny\r\nz\r\n` | `780d0a790d0a7a0d0a` | CRLF lands as CRLF |
| `writeText` CRLF content onto a NEW file | `p\r\nq\r\n` | `700d0a710d0a` | CRLF lands as CRLF |

- `editText` PRESERVES the target's style because it makes a PARTIAL change: it captures
  `original.lineEndings` and calls `restoreLineEndings(...)` before the atomic write
  (`packages/fs/fs-local/src/index.ts:253-255`). [read in source]
- `writeText` does NOT restore, and must not: it is a FULL replacement in which the caller
  stated the complete content, so restoring a style the caller did not ask for would make it
  impossible to write an LF file over a CRLF one at all. `normalizeLineEndings` applies only
  to the returned `after` DIFF BASIS (`:224-227`), which is why `after` is LF while the bytes
  are CRLF.

**Not a difference from the sandbox backend:** `sandbox-crlf-probe.json` runs the same
operations against BOTH classes and reports `writeTextOnDiskIdentical: true`,
`editOnDiskIdentical: true`. The sandbox backend has no line-ending code of its own — it
inherits `fs-local`'s. So the old FS-05 failure was **pre-existing and not caused by the
swap**.

**What changed, and why it is not a weakening.** The old assertion applied `edit`'s contract
to `write` ("a write normalizes content to the file's own style") — FALSE, and it is the
`edit` contract. It was replaced by the measured contract in BOTH directions (LF in → LF out,
CRLF in → CRLF out) plus a two-paths-on-one-file control, so **coverage of `write` went from
one assertion to four**. The gate's real property — a CRLF file stays CRLF through an `edit`
— is unchanged and still asserted.

**VERDICT: PASS.**

---

## 8. FS-06 — workspace files and store-owned artifacts are not conflated

**Oracle:** the record distinguishes workspace paths from store-owned artifacts, and the
store's object is unaffected by the workspace write. Assuming an artifact is immutable merely
because a cell can write a same-named path is NOT PASS.

**Commands and raw output:**

- `node qualification/runners/v7-fs-driver.mjs` → `boot.json → fs06`, `VERDICT.json → fs06`
- `cd packages/dsh-daily-work && node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/verification-gates.test.ts -t "FS-06" --maxWorkers=1 --no-file-parallelism` → `fs06-verification-gates.txt` (**2 passed**, exit 0)
- `cd D:/DSH/src/dsh-src && node --import tsx/esm D:/DSH/work/dsh-native-daily/qualification/runners/t2-probes/fs06b-probe.mts` → `fs06b-probe.json`
- `python-newline-measurement.txt` (below)

**The store distinguishes itself from the workspace [measured]:**

| fact | value |
|---|---|
| store root as configured | `data-artifacts` — **relative** |
| resolved against | the **host process cwd** → `D:\DSH\src\dsh-src\data-artifacts` |
| `ownerScope` / `executionWorld` | `project:daily` / `local` |
| a published object's address IS its content digest | `true` (`artifact:sha256:07d894c4…`) |
| a workspace file with the artifact's own name changed the store object | **NO** — `storeBytesUnchanged: true`, `objectOnDiskUnchanged: true` |
| the store's own `stat` after that write | unchanged: `{bytes: 76, sha256: 07d894c4…}` |

**VERDICT: PASS.** The store's object was unaffected by the same-named workspace write, and
the store's own verdict on its object is reported rather than assumed.

### The findings this case produced, recorded in the direction they were measured

1. **ONE RELATIVE NAME, TWO FILES.** Because the root is the relative literal
   `data-artifacts` (`packages/dsh-daily-work/src/data-service.ts:400-406`) and the profile
   sets no `artifactRoot` (DIFFERENCE 5 says so deliberately), the store resolves it against
   the **host process cwd** while the `fs` tool resolves the SAME relative string against the
   **session cwd**. Measured: the tool's `data-artifacts/objects/07/…` landed at
   `…\V7-fs\workspace\data-artifacts\objects\07\…` while the store's object is at
   `D:\DSH\src\dsh-src\data-artifacts\objects\07\…`. `sameRelativeNameTwoFiles: true`. This is
   a naming divergence, not a permission boundary — the absolute path reaches the object.
2. **The store object is immutable IN FACT, not by convention.** Published `0o400`
   (`objectModeOnDisk: {octal: "444", writableByOwner: false}`), so the native write through
   the absolute path is refused by the OS with `ReplaceFileW EACCES` — not by a DSH policy
   decision. `refusalCameFromTheOS: true`.
3. **The bit is a guard, NOT a boundary — and the read path does not verify.**
   Counter-check, measured: the same OS user CAN clear the bit and overwrite the object
   (`theObjectCouldBeOverwritten: true`). While tampered, `openRange` **threw no error and
   returned the tampered bytes** — its own source says verification is separate
   (`artifacts.ts:391`: *"Verify the whole object against its address. Explicit, so paging
   stays O(page)"*). The explicit `verify()` DOES detect it
   (`theExplicitVerifyDetectedTheTampering: true`). `stat()` cannot detect it either: it
   reported `{bytes: 30, sha256: 07d894c4…}` — the ORIGINAL digest beside the TAMPERED byte
   count, because the digest is derived from the reference name. The probe restored the
   object it tampered (`restored: true`).

   **This finding is the correction of a false claim I wrote.** The first version of this
   probe asserted, in a CHECK LABEL, that the store detected the tampering — while the
   measured value said the opposite. A label claiming detection that did not happen is
   exactly the failure mode this spec exists to catch, in the green direction. The label now
   says what was measured, and the two FINDING checks assert the measured direction
   (`readPathReturnedTamperedBytes === true` and `readPathThrewAnError === false`).

### FS-06's raw-Python failure was a HOST artifact, not a product behaviour

Independently re-measured (`python-newline-measurement.txt`, Python 3.14.3):

```
default newline : b'x\r\n'
newline= empty  : b'x\n'
```

The fixture omitted `newline=''`, so CPython's text mode translated `\n` to `\r\n` on this
Windows host. The case was therefore measuring the **host's line separator**, not whether the
mutation is visible — and it failed for that reason, not because anything was invisible.
`newline=''` was added to the fixture. **The visibility assertions were untouched**: the
mutation still bypasses DSH entirely, still produces no fs receipt, and is still asserted
visible from the world.

The third FS-06-shaped failure was a **different cause in the opposite direction**:
`verification-gates.test.ts > FS-06 > the raw-Python write is caught by the candidate/HEAD
comparison` expected `accept_for_publication` and got `refuse`. Dumped by probe, not inferred
(`fs06b-probe.json`):

```
"there is no acceptance receipt, so there is no evidence that any test ran"
"no acceptance receipt was supplied, so nothing about the candidate has been verified"
```

The fixture passed **NO RECEIPT AT ALL** (`patchApplies: true`, `scopeOk: true`,
`baseRevisionMatches: true` — so the refusal came from the missing receipt alone). A case that
fails for an unrelated reason cannot measure the property it names, and one that PASSED on a
missing receipt would have been worse. The fixture now produces a REAL receipt from a REAL
vitest run and measures BOTH halves: the residual gap (without `definition`, the tree digest
is the recorded one, so the uncommitted raw edit is not caught → `accept_for_publication`) and
its closure (with `definition`, the digest is recomputed from disk, the binding fails on
`candidateTreeDigest`, and the candidate is `refuse`d). The gap is closable and the closing is
measured.

---

## 9. What these verdicts do NOT establish

- **No confinement claim of any kind.** Under trusted-local there is none to establish. Every
  "succeeded" above is the DEPLOYED behaviour, not a bug, and the three FS-04 non-refusals are
  findings rather than passes of a boundary.
- **Not that the removed fence was an acceptable loss.** That is a security judgement recorded
  in `qualification/results/T3-shell/FINDINGS.md` and `docs/SECURITY.md`, not here.
- **The FS-01 substitution is real**: the literal `pwsh` vector the stimulus names does not
  exist in this deployment (absent by architecture), so the property was measured on the
  mounted routes. A reader requiring the literal vector must record FS-01 NOT_RUN.
- **`sandboxPolicy.defaultMode` / `ptcRuntime.sandboxMode` remain `workspace-write`**, and the
  product's own guard reports both as violations. See §3.

## 10. Evidence files

| file | sha256 |
|---|---|
| `qualification/results/V7-fs/VERDICT.json` | `66f5919d154e12e474fa61f9bebe2d23885ad114ebaf0cb2cf0d6e72a22d6dc4` |
| `qualification/results/V7-fs/boot.json` | `fda3b412cee4b636df7410f9d93275d23e115ac1c0085a35875ab15ab3ee4794` |
| `qualification/results/V7-fs/transcript.txt` | `960dd4a55042f71e3943ff2a6207b6374fde0aabd6f6c7eb9f44e0e5f0a5e7e5` |
| `qualification/results/V7-fs/t9c-tests.txt` | `3a365ab026d4a5792fd80e452a127dcf3217edfc335c31433795a6017d322b5e` |
| `qualification/results/V7-fs/crlf-probe.json` | `17f2240e2022d2f94d91754bcfedc9e0396811b7be690ee7e510c8f12b2ca8df` |
| `qualification/results/V7-fs/sandbox-crlf-probe.json` | `aba7c1b0be54a1a537ec2e60129418eb3a6c6bcf0c682db4cdacbd5dfb15b6b3` |
| `qualification/results/V7-fs/fs06b-probe.json` | `13c5b821a2609c65ab981d5eba37ffcc8051e3035d48f7fa828fd1204abac63c` |
| `qualification/results/V7-fs/fs06-verification-gates.txt` | `5ef7e732821df2167d308b3d1d61ce7aff4bbaa1ef55beeb99aab95a0fa679a7` |
| `qualification/results/V7-fs/python-newline-measurement.txt` | `deb1a901eb97e38a7c647937f5e8b378a1df6c331b30cb61bfd8099dcf427a37` |

Supporting evidence filed by T2, cited above and unchanged by this slice:
`qualification/results/T2-fs/VERDICT.json`, `.../CONTROL.json`, `.../FINDINGS.md`.

**Process hygiene.** One host at a time through the shared harness; a single vitest file per
run with `--maxWorkers=1 --no-file-parallelism`; no load loops or CPU spinners; no
drive-root walks. The host was SIGKILLed and the port verified released. The probe restores
every artifact it tampers with, and the one object it published into the pinned checkout's
`data-artifacts/objects/07/` was removed, leaving only the pre-existing `15/` (02:02, before
this slice).
