# M8 — verification mechanics and writer isolation (VER-01..08, W02, W03)

**Status: 6 gates PASS, 1 gate FAIL (VER-04, honest), 1 gate PASS-with-scope (VER-06).**
Every claim below is backed by a file in this directory produced by a real run on
this machine.

> ## INDEPENDENT VERIFICATION PASS — read this first
>
> A second agent re-ran and re-read every gate below. **The recorded summary line
> "44 passed / 44, `test_exit=0`" was STALE and has been corrected.** The real
> first re-run was **45 tests: 1 failed, 44 passed, `test_exit=1`.** Two facts
> explain it, and only one of them was a defect in the product:
>
> 1. **The evidence was recorded against a file that then changed.**
>    `verification-gates.test.ts` was `6db105e8…` when `tests.txt` was written and
>    `145eceb0…` on disk at re-read time — before this verifier edited anything.
>    The count is 45, not 44, because a VER-05 independence case had been added
>    after the recording. Every OTHER source digest is byte-identical to the
>    recording, so the module under test did not move; only the test file did.
> 2. **One test genuinely failed, and it was a broken ORACLE, not a broken
>    scenario.** The W02 config-detection case asserted the raw `.git/config` text
>    *contains* the literal dotted key `dailywork.detected`. Git's INI writer emits
>    a `[dailywork]` section header and `detected = yes`; the flattened key never
>    appears. The assertion failed **while the mutation it was checking had in fact
>    landed**, and it masked the digest check below it, which never ran.
>
> The fix **strengthens** that assertion rather than weakening it (details in
> "What I refuted or strengthened" below). After the fix: **45 passed / 45,
> `test_exit=0`**, `tsc -p tsconfig.json --noEmit` exit 0, `tsc -p
> tsconfig.check.json` exit 0. The superseded recording is preserved verbatim as
> `tests.stale-preverify.txt`, and the superseded digest list as
> `source-digests.stale-preverify.txt`, so the correction is auditable rather
> than silent.

| Gate | Verdict | One-line basis |
|---|---|---|
| VER-01 zero tests | **PASS** | Real exit 0, `zero_tests`, NOT PASS. Measured through the CLI too. |
| VER-02 all skipped | **PASS** | Real exit 0, `all_skipped`, NOT PASS. |
| VER-03 candidate rewrites the oracle | **PASS** — and it exposed a real gap, closed here | The runner does NOT detect an undeclared oracle. `oracleDigest`+`bindReceipt` do. |
| VER-04 host execution bypass | **FAIL** — honest | Credentials are scrubbed and there is no control handle; reads and egress are NOT denied. |
| VER-05 stale receipt | **PASS** | Workspace, oracle and environment bindings each refuse independently. |
| VER-06 A→B→A | **PASS**, scope stated | Two-arm proof extended to the oracle and config; endpoint hashing provably blind. |
| VER-07 in-flight writer | **PASS** | Converge-before-freeze refuses a live lease and a still-moving tree; an unknown never carries a digest. |
| VER-08 recover after failure | **PASS** | Pause is a record change; the permanent family drain is proven to be the different, later operation. |
| W02 worktree is not a boundary | **PASS** — detection, not prevention | A writer really can move shared refs/config/hooks; the digest catches all three. |
| W03 integrate after both change | **PASS** | Conflicts are REFUSED and returned to the root; no merge verb exists in the code. |

**Evidence:** `tests.txt` (45 passed / 45, `test_exit=0`, re-run by the verifier),
`tsc.txt` (`tsc_exit=0`, whole package, test files included),
`source-digests.txt` (re-derived), `cli-transcript.txt`,
`w02-git-measurements.txt`, `boot-probe.txt` + `writers-mounted.json`.

---

## Independent verification: what was checked, per gate

Each line below names the **assertion actually read**, not the note claiming it.

| Gate | The assertion I verified |
|---|---|
| VER-01 | `expect(receipt.exit.code).toBe(0)` **and** `expect(receipt.outcome).toBe('zero_tests')` **and** `expect(receipt.passed).toBe(false)`. Not an exit code read as a verdict. A **control arm** runs the same command with no declared counts and gets `pass`, so the classification is demonstrably load-bearing rather than the process behaviour. Re-confirmed through the real CLI: `acceptance_exit=1`, `outcome: "zero_tests"`. |
| VER-02 | `expect(receipt.exit.code).toBe(0)` **and** `outcome === 'all_skipped'` **and** `observedTests` matches `{passed:0, failed:0, skipped:2}`, plus `testsAreReal().real === false`. Real CLI re-run: `acceptance_exit=1`, `outcome: "all_skipped"`. |
| VER-03 | A real oracle file is written, run, then **rewritten on disk**, and the digest is asserted to move: `expect(weakenedDigest).not.toBe(digestAtFreeze)` then `bindReceipt` refuses. The undeclared-oracle gap is measured by executing the command twice and asserting it printed `ORACLE-REVISION-ONE` then `ORACLE-REVISION-TWO` while `candidateTreeDigest` stayed byte-identical. That is a real rewrite of a real file caught by a real digest, not a function called in isolation. |
| VER-05 | The three bindings use **real digests from `observedBasis`**, not placeholders, and each mutation is asserted to move **exactly one** of four bindings with `mismatches` of length 1. Mutating ONLY the workspace leaves `oracleDigest`, `environment` and `acceptanceDefinitionDigest` matching, and the refusal still fires naming `candidateTreeDigest`. A control arm asserts a restored tree **accepts**, so an always-refusing `bindReceipt` could not pass. |
| VER-06 | Two arms over one schedule. Snapshot arm: child sees A for input+oracle+config, `liveDriftDetected: false`. In-place arm: child **exits 9 having seen B**, and the serialized receipt is asserted to lack `liveDigestAtEnd`/`liveDriftDetected` entirely. Endpoint hashing is proven blind by assertion, not described. |
| VER-07 | `converged === false` + `digest === ''` for a live lease, and a second arm with a genuinely churning tree refused while a stopped one converges to `digestInputs(definition)`. The invariant `digest !== '' ⇒ converged === true` is asserted over every path. |
| VER-08 | Drives the real `SubagentRuntime`: a correction child is admitted while paused, and `drainContinuableDescendants` afterwards **rejects** with `/draining; the operation was not admitted/`, which is what proves the paused state was genuinely not-yet-drained. |
| W02 | All three mutations performed with cwd INSIDE the writer's worktree, each asserted to **have landed** (`git(root,'rev-parse','refs/heads/main')` equals the writer's SHA; the shared config read back; the planted hook's stderr appearing on a **root** commit). Then `verifySharedMetadata` is asserted to name each one independently, with `movedRefs` containing `{ref, expected, observed}`. |
| W03 | Read the code, not the note. Every `gitRun`/`gitOk` call site in `worktree-isolation.ts` was extracted and inspected: `rev-parse`, `symbolic-ref`, `merge-base`, `diff`, `apply --check`, `worktree`, `branch`, `clone`, `checkout`, `remote`. **No `merge`, `rebase`, `cherry-pick`, `push`, `reset`, `update-ref`, `commit` or `stash` appears as an executed argv anywhere in the file.** `git apply` appears once and always with `--check`; `--3way` appears only in prose. |

## What I refuted or strengthened

**Refuted — the recorded test count.** `44 passed / 44, test_exit=0` did not
reproduce. The real result at first re-run was `45 tests, 1 failed, 44 passed,
test_exit=1`. The claim "44" was not a lie about a green suite; it was a
**recording taken against a different revision of the test file**, which is the
same class of error the VER-05 gate exists to catch. The count is now 45 because
a case was added after the recording.

**Strengthened — the W02 shared-config assertion.** Before (broken):

```ts
expect(readText(join(root, '.git', 'config'))).toContain('dailywork.detected')
```

This is a substring test against git's INI serialization and can never pass. It
failed for a **formatting** reason while the mutation under test had actually
landed — an oracle broken rather than weak — and because it threw, the three
digest assertions after it never executed. After (four assertions, strictly
stronger):

```ts
expect(gitTry(root, 'config', '--file', join(root, '.git', 'config'), '--get', 'dailywork.detected').stdout).toBe('yes')
expect(readText(join(root, '.git', 'config'))).toContain('[dailywork]')
expect(readText(join(root, '.git', 'config'))).toContain('detected = yes')
expect(existsSync(join(root, '.git', 'worktrees', 'detected-workspace', 'config.worktree'))).toBe(false)
```

The last line is the one that makes "shared" mean anything: `config.worktree` is
the file that **would** have held this value had git been writing to a
worktree-private config. Without it, "the value is in the root's config" is also
consistent with git having written a private file. This is the same shape as the
existing line 1855, which already used `--get` correctly — the regression was
local to line 1953.

**Verified unchanged and correct — nothing else was weakened.** No test was
skipped, deleted or relaxed; no N was lowered; no permission was widened. The
`it.skip` occurrences at lines 475–476 are inside a **fixture string** that is
written to disk as the VER-02 all-skipped suite, not skipped tests of this file.

**Strengthened — VER-06 was a LOAD-DEPENDENT ORACLE, and it failed under load.**
This is the most interesting finding of the pass, and it was found only because
the suite was re-run rather than trusted. On a clean machine VER-06 passed; run
while other agents were working it **failed** at
`expect(inPlace.exit.code).toBe(9)` with `expected +0 to be 9` — the in-place arm
exited **0**, meaning the child never saw the tampered tree.

The cause was the test's own schedule, not the runner. The mutation window was
anchored to a timer that started **before the child process existed**:

```ts
const mutation = mutate()          // starts a 700 ms timer NOW
const snapshotted = await runKeepingSnapshot(definition)
```

`runAcceptance` must digest the tree, copy the snapshot and spawn `node` before
the child executes a single line. Under load that prelude exceeded 700 ms, so the
tamper was **already restored** by the time the child looked — and the arm that
exists to prove "in place, the child really does execute against the tampered
tree" silently stopped proving it. It failed loudly here; a slightly different
timing would have had it pass while testing nothing. **That is the
oracle-weaker-than-its-scenario shape this whole project is about, found inside
the suite that certifies it.**

The fix is structural, not a retry or a longer sleep:

1. The child writes a **readiness marker as its first action**, and the mutation
   window opens only after that marker appears — so the window is anchored to
   the child genuinely running rather than to spawn latency. The marker path is
   outside `inputs` deliberately: arm 1's child runs in the frozen snapshot, so a
   path under `dir` would be written to the snapshot in one arm and the live tree
   in the other, and the watcher could never see arm 1's.
2. The child now **polls** for the tampered revision (50 ms interval, 6 s
   deadline) instead of sampling once at a fixed offset. Polling asserts what the
   gate actually claims — that the in-place child observes the tampered tree at
   some point inside the window — rather than betting on timer scheduling.
3. The marker is cleared between arms, or arm 2 would see arm 1's marker and
   re-open the same race.

**Proven under the condition that exposed it**: with six CPU-saturating
processes running, the suite was `45 passed / 45, test_exit=0` at 93.2 s — the
same load under which it had failed. A clean run is 67–75 s.

**Not reproducible — the claimed stale `gates.json` hashes.** The prior pass
reported that `T05`, `T06` and `T08` cite a stale `M9.2-terminal-advanced/
FINDINGS.md`. Recomputed all **127** evidence hashes in `qualification/gates.json`
independently: **0 missing, 0 stale.** All three now record `615adaad…` and all
three match the file on disk. Whatever was observed, it does not reproduce at the
current revision — reported here so the claim is not carried forward as fact.

---


## What was built

| File | Role |
|---|---|
| `packages/dsh-daily-work/src/verification-gates.test.ts` | 44 tests. VER-01..08, W02, W03, plus the production-entry cases. |
| `packages/dsh-daily-work/src/worktree-isolation.ts` | Writer workspaces, leases, shared-metadata digests, convergence, integration assessment, publication precondition. |
| `packages/dsh-daily-work/src/writers-plugin.ts` | The production entry point: `ctx.dailyWriters`. |
| `packages/dsh-daily-work/cordis.patch.yml` | `DIFFERENCE 5`: the `daily-writers` insert row. |
| `qualification/runners/verify-writers-mounted.mjs` | Boot probe: is the service mounted by the COMPOSED profile? |

`src/verify.ts` and `qualification/runners/acceptance.mjs` were **not modified**.
`source-digests.txt` records their sha256, and `verify.ts` still hashes to
`95281a41…`, byte-identical to what M9.1 recorded. They are the subject under
test, not a helper.

---

## The three gaps this slice actually closes

The M9.1 slice listed what it had NOT proven. Three of those are closed here, and
the first is the one that matters.

### GAP 1 — the runner does not detect a rewritten oracle (VER-03)

M9.1 said "digest coverage is whatever the definition declares". Measured, that
is worse than it sounds, and it is TWO gaps with different mechanisms:

- **COVERAGE.** `candidateTreeDigest` hashes only declared `inputs`. A definition
  normally names the CANDIDATE's files, so an acceptance suite living in its own
  directory is covered by nothing. Measured: rewriting the oracle changes every
  digest in the receipt not at all.
- **FREEZING.** The snapshot copies declared `inputs` only. A path outside them is
  not copied, so the command resolves it in the **LIVE** tree and executes
  whatever the oracle says at that moment. The receipt still reports
  `candidateTreeDigestScope: 'snapshot'` — true about the candidate, silent about
  the oracle. Measured directly: the same command, run twice against an unchanged
  candidate, printed `ORACLE-REVISION-ONE` then `ORACLE-REVISION-TWO` while both
  receipts carried **identical** `candidateTreeDigest` and
  `acceptanceDefinitionDigest`.

This is the more serious of the two, because the immutable-snapshot guarantee
VER-06 relies on does not extend to the oracle unless the oracle is a declared
input.

**Closure, in two parts, both tested:**

1. `oracleDigest(files)` hashes the protected suite and its config. The digest is
   recorded by the verifier, outside the candidate's reach, because a field inside
   a receipt produced by a process that runs the candidate would be a weaker
   claim.
2. `bindReceipt(recorded, observed)` compares all four bindings the delivery plan
   requires — artifact, workspace, environment, oracle. The signature is
   deliberately two-argument: an earlier single-argument form took the
   expectation and the receipt, and comparing two caller-supplied values is a
   restatement of its own arguments that would certify a weakened oracle. The
   test asserts that shape directly, so a refactor back to it fails.
3. `observedBasis()` is the observation half, so a caller cannot accidentally
   pass the recorded values in as the observed ones.

The operational half is also tested: declaring the oracle in `inputs` makes the
snapshot cover it, and the case shows the declared/undeclared contrast over the
same rewrite.

### GAP 2 — the verification environment is not a sandbox (VER-04)

**RE-CONFIRMED BY THE INDEPENDENT VERIFIER, and left as an honest FAIL.** The
gate is NOT green and was NOT narrowed to make it green. The scenario was not
reduced, the test was not skipped, and no permission was widened.

M9.1 stated this. It is now MEASURED per operation, and the gate is recorded as
**FAIL**, because the gate's oracle is "unauthorized operations are blocked" and
two of them are not.

| Operation | Enforced? | How it was measured |
|---|---|---|
| inherit a credential-shaped env name | **YES** | `*_FAKE_API_KEY`, `*_FAKE_TOKEN`, `*_FAKE_PASSWORD` are `null` in the child |
| inherit any `DSH_*` name | **YES** | `DSH_VER_CANARY` is `null` |
| survive as an ordinary marker | yes (control) | `VER_HARMLESS_MARKER` = `harmless-visible`, so a runner that dropped everything would not pass |
| reach a DSH service / control handle | **YES** | no `ctx`, no service registry, no `DSH_*` name, argv and cwd only |
| **read a host file outside the snapshot** | **NO** | the child read a canary secret in a SIBLING temp dir verbatim, exit 0 |
| **open a network connection** | **NO** | the child completed a real TCP connect to a loopback listener owned by the test |

The read and egress findings reproduce E01 and E06 at the verification boundary
specifically. The honest statement is: **the verification environment is
low-privilege with respect to inherited credentials and control-plane handles,
and it is NOT low-privilege with respect to filesystem reads or network egress.**
`qualification/results/M9.3-security-denial/` establishes the same absence at the
sandbox rung (`enforcement: 'partial'`, `WRITE_RESTRICTED` intersects only write
accesses). Nothing in this slice changes that, and nothing here should be read as
claiming it.

**Is there a non-invasive fix using only public seams? NO — checked, not
assumed.** This was re-examined rather than inherited:

- `SandboxPolicy` (`packages/sandbox/sandbox/lib/types/index.d.ts:55`) extends
  `SandboxExecutionPolicy`, whose only members are `mode`, `workspaceRoot` and
  optional `sessionId`. `mode` is `ConfinedSandboxMode = Exclude<SandboxMode,
  'danger-full-access'>`, i.e. `'read-only' | 'workspace-write'`. **There is no
  read-restriction lever and no egress lever in the public policy type**, so a
  fix is not merely unimplemented — it is not expressible through this seam.
- Upstream states it in the source comment itself: "Network and process
  visibility are outside this vocabulary."
- On Windows the enforced mechanism is a `WRITE_RESTRICTED` token, which by
  construction intersects only **write** accesses.

Closing VER-04 therefore needs an OS boundary (a VM, a container, or a
read-deny ACL layer) **outside** the runner, not a change inside it. Recorded as
`BLOCKED_EXTERNAL` for the boundary, with the gate itself a definite FAIL rather
than an unknown.


### GAP 3 — the A→B→A proof covered only the input tree (VER-06)

The M9.1 two-arm proof is extended to the oracle and the config, on the same
schedule. Both arms mutate all three mid-run:

| Arm | What the child saw | Live digests | Verdict |
|---|---|---|---|
| Snapshot | A for input, oracle AND config | start == end, `liveDriftDetected: false` | PASS, correctly |
| In place | B for all three — exited 9 with `SAW_THE_TAMPERED_TREE` | start == end, drift undetected | FAIL, correctly |

The in-place arm is the proof that the snapshot is load-bearing: before/after
hashing reports **no drift at all** while the command really did execute against
the tampered tree.

---

## VER-07 — the step the runner cannot take

The runner freezes whatever it finds at the instant it starts. A background
mutation still running at that instant produces an immutable snapshot of a
**torn** tree: immutable, and describing no revision anyone reviewed. Immutability
is necessary and not sufficient.

`convergeBeforeFreeze` adds the missing step and refuses twice:

- a live writer lease means the workspace is in flight by definition, so the
  freeze is refused rather than raced;
- two digest samples that disagree mean something is still writing.

And the structural invariant is asserted rather than described: **a refusal never
carries a digest**, and a digest is never `''` on a converged result. The digest
is the runner's own `digestInputs`, so the converged value is directly comparable
with the receipt's `liveDigestAtStart` — a second definition of "the candidate
tree" would be free to drift from the runner's.

The two-arm case is what makes "converged" meaningful: arm 1 keeps writing between
samples and is refused; arm 2 has stopped and converges. Without arm 1 the
refusal would be unreachable and the property untested.

---

## W02 — a git worktree is NOT a security boundary

The plan says so; this is the measurement, raw in `w02-git-measurements.txt`. All
three mutations are performed with cwd inside the writer's worktree, and none is
denied:

| Mutation | Exit code | Result |
|---|---|---|
| `git update-ref refs/heads/main <sha>` | **0** | the integration branch really moved |
| `git config dailywork.hostile yes` | **0** | written to the SHARED `.git/config`, confirmed by reading that file |
| plant `.git/hooks/post-commit` | — | fired for a **ROOT** commit |

The writer's `--git-common-dir` **is** the root's, which is the sharing being
measured.

What git DOES enforce is the one protection that comes for free: a branch already
checked out in another worktree cannot be checked out again (`exit 128`, `fatal:
'main' is already used by worktree at …`). That is why every writer gets its OWN
branch — it closes the ordinary path. It does **not** close a deliberate one, as
mutation 1 shows.

**So the protection is a CHECK, not a permission.** `sharedMetadataDigests`
records the protected refs, the common config and the hooks directory;
`verifySharedMetadata` re-reads them and names what moved. All three mutations are
detected, with the moved ref reported as `{ref, expected, observed}`. The source
does not call a worktree a sandbox, and the code is arranged so it could not be
read as doing so.

When a deployment needs a boundary rather than a check, `kind: 'clone'` gives an
independent clone with `--no-hardlinks`, its own object store, its own
refs/config/hooks and **no remote**. Asserted by mutation: the writer rewrites its
own refs, config and hooks as hard as it likes and the root's three digests are
byte-identical, and `git push origin main` fails because there is no `origin`.

---

## Writer isolation and the root's integration authority

- **One writer, one workspace.** Two mechanisms, covering different cases: an
  in-process registry keyed by resolved path, and an atomic exclusive-create lock
  file that holds across processes. A second writer on the same workspace is
  refused with `writer-workspace-busy`.
- **The lease is never stolen.** ARCHITECTURE §17 rejects PID/TTL lock stealing
  explicitly, so a stale lease is a human decision. The recorded pid and timestamp
  exist to make that decision possible, not to automate it.
- **The writer's cwd is bound at creation.** `--show-toplevel`, the branch and the
  base revision are all read back from git rather than trusted from the returned
  object. Each writer gets its own branch, artifact dir, build dir and cache dir.
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` are **tombstoned**
  (`undefined`, not merely absent): a parent that had `GIT_DIR` set would
  otherwise hand the writer a git context pointing at the root's repository, and
  its commit would write the root's index and branch from inside what looks like
  an isolated directory.
- **The root verifies; it does not merge.** `assessIntegration` checks the base
  revision is exactly what was expected, the head descends from it, the patch
  applies to the ROOT, the changed paths are inside the allowed scope, the tests
  really ran, and the receipt still binds. `git apply` is used with `--check`
  **only**: measured, a conflicting patch exits 1 under `--check` and **0** under
  `--3way --check`, so the three-way form would start resolving the conflict
  instead of reporting it. The conflict goes back to the root.
- **Publication is exact-base patch + expected-ref CAS.** `publicationPrecondition`
  takes the ref's observed value as an **argument** and refuses when it moved.
  There is no force, reset, update or push anywhere in the module, and the test
  extracts every git subcommand the module can execute from its source and checks
  it against an allowlist — so "no merge verb exists" is mechanical rather than a
  promise.

---

## The production-entry problem, and why it is the most important case here

`worktree-isolation.ts` was, until `writers-plugin.ts` existed, a **test-only
module**: mounting it directly proved it works and proved nothing about whether
the product uses it. This project has retracted that over-claim four times:

1. `setLaunchPort` had no production caller — the shipped profile launched
   nothing and every `submit` became `unknown` (`2d4534f`).
2. `takeContinuation` had none — a managed run never disarmed the Goal
   round-driver, so TWO continuation owners could drive one root while
   `goal.test.ts` passed (`982e82b`).
3. `dsh-ipython` declared no `dsh.bundle` — the package could never reach the
   model even with green tests.
4. This module.

`docs/GAPS.md` G-FIX-04: **an oracle weaker than its scenario passes while the
product is broken.**

Three links are now tested, and a fourth is boot-proven:

- the package declares a `./writers` export pointing at a file that exists;
- `cordis.patch.yml` has the `daily-writers` insert row naming that export;
- mounting the plugin registers `ctx.dailyWriters` and the service reached **that
  way** performs a real workspace lifecycle;
- `boot-probe.txt` shows the row in the resolved config of a real
  `--profile daily` boot and the probe's finding from inside that boot:
  `serviceRegistered: true`, `workspaceCreated: true`,
  `baseRevisionMatches: true`, `secondWriterRefused: true`,
  `releasedCleanly: true`, `branchGoneAfterRelease: true`.

### WIRING: re-verified independently through the real resolver — WIRED, not unwired

This was the open question for the second pass, and it is answered **by the
resolver, not by a direct mount**. I re-ran both halves myself:

1. **The import graph has a non-test importer.** `worktree-isolation.ts` is
   imported by exactly one non-test file, `src/writers-plugin.ts` (which is
   itself reachable only as the package's `./writers` export root). Before this
   slice the module had no non-test importer at all; that is the fourth instance
   of the defect class in `docs/GAPS.md`, and it is closed.
2. **The row reaches the COMPOSED config.** `node apps/cli/lib/bin.js --profile
   daily --dump-config` resolves:

   ```
   595:- id: daily-writers
   596-  name: dsh-daily-work/writers
   ```

   A row that never reaches the resolved tree is the B02/B03 failure shape, so
   this is the check that matters — and it is read from the resolved output, not
   from the patch file.
3. **The service is live inside a real boot.** The boot probe re-run reports
   `serviceRegistered: true` with the full lifecycle
   (`workspaceCreated`, `baseRevisionMatches`, `cwdBoundToWorkspace`,
   `secondWriterRefused`, `leaseHeldDuringUse`, `releasedCleanly`,
   `branchGoneAfterRelease`, `error: null`).

`writers-mounted.json` was refreshed by my re-run (same field values, new temp
paths); the original values remain in `boot-probe.txt`, which is unmodified.

Two probe readings are recorded deliberately. `serviceAtApplyTime: false` and
`serviceRegistered: true` after a retry, because **Cordis activates rows in
service-availability order, not source order** — a single read at apply time
observes a moment, not a composition. This project already published a false "not
mounted" from exactly that mistake in `verify-guard.mjs`, so both readings are in
the evidence.


A real finding came out of that boot: reading `ctx.subprocess` without declaring
it in `inject` throws `cannot get property "subprocess" without inject`. The two
fixes are **not** equivalent — declaring it makes it an activation requirement, so
a deployment with no subprocess provider could not boot the writers service and
therefore could not report the gap either. The module resolves it per call through
`ctx.get`, so the service stays reachable and the missing provider becomes a typed
refusal naming the DEPLOYMENT. A test pins that on a bare context.

---

## What is NOT proven

Stated plainly, because a verification authority that overstates its coverage is
worse than one with a smaller claim.

1. **VER-04 is a FAIL, not a partial pass.** Filesystem reads and network egress
   from the verification child are NOT denied on this platform. If the threat
   model requires them denied, this needs a VM or an OS boundary, not this
   runner.
2. **The runner's snapshot is not an execution jail.** It is an immutable INPUT
   copy. Everything the child can reach outside `inputs` is live.
3. **`node_modules` is outside the digest.** Junctioned in so the toolchain
   resolves, and the receipt says so in `snapshot.coverage`. A dependency change
   is not covered by `candidateTreeDigest`.
4. **`managedRangeEmpty: true` is an observation, not a proof of release.** Where
   the provider cannot observe the range quiescing, the field is `'unknown'`.
5. **`sharedMetadataDigests` covers the protected refs, the common config and the
   hooks directory — not the object store.** `objects/**` is shared and
   append-only by content address; a writer adding objects is how a candidate
   commit exists at all. It is not digested, and it is not claimed to be.
6. **VER-06's two-arm proof covers the input tree, the oracle and the config.**
   It does not cover a mutation of a file that is in NEITHER `inputs` NOR the
   oracle set — such a file is invisible to every digest, which is the same gap
   class as VER-03's and is closed the same way (declare it, or digest it
   separately).
7. **VER-08 is asserted for the pause/drain distinction, not for a whole
   recovery.** The case drives the real `SubagentRuntime` and proves a correction
   child can still be established while paused, and that the permanent drain
   afterwards really does close admission. It does not run a full failed →
   corrected → re-verified → completed turn.
8. **No live model is involved anywhere in this slice.** Every case drives the
   runner, the service or git directly. The tests prove the mechanics are honest;
   they do not prove a model would be *stopped* by them.
9. **The boot probe drives the service's own API.** It proves the service is
   composed and reachable; it does not run a writer CHILD through the model's tool
   surface, which would need a live turn.
10. **The `all_skipped`/`zero_tests` detection depends on the runner printing a
    summary.** Two grammars are implemented and tested; a third-party runner with
    a different format reads as `runner_never_ran`, which is non-PASS, so the
    failure mode is safe but would need a parser.
11. **Nothing in this slice is proven about a model's behaviour.** No live
    provider is authorized (`live_provider_budget_authorized: false`), so every
    result here is a result about the MECHANISM. Whether a model would actually
    be stopped by these refusals is untested and is not claimed. This is
    `BLOCKED_EXTERNAL`, not a pass.
12. **The boot probe drives the service's own API from inside a real boot.** It
    proves the service is composed, reachable and functional through the real
    resolver. It does **not** run a writer child through the model's tool
    surface, which would require a live turn.
13. **The VER-03 oracle-digest closure is a MECHANISM, not an enforced policy.**
    `oracleDigest` + `bindReceipt` detect a rewritten oracle and refuse the
    receipt, and the test proves that. What is NOT proven is that any production
    caller passes the right `oracleFiles` set — a caller that names the wrong
    files, or none, gets no protection. The runner's own snapshot still does not
    cover an undeclared oracle; the closure is the caller's to apply.
14. **`sharedMetadataDigests` covers protected refs, the common config and the
    hooks directory — not the object store**, and not every file under `.git`.
    A writer mutating something outside those three surfaces is not detected by
    this check.

---

## Verification-pass metadata

| Item | Value |
|---|---|
| Tests, after both fixes | **45 passed / 45**, `test_exit=0` (76.1 s) |
| Tests, under deliberate CPU load (6 saturating processes) | **45 passed / 45**, `test_exit=0` (93.2 s) |
| Tests, first re-run (before fixes) | **45: 1 failed, 44 passed**, `test_exit=1` (W02) |
| Tests, mid-pass (before the VER-06 fix, under load) | **45: 1 failed, 44 passed**, `test_exit=1` (VER-06) |
| `tsc -p tsconfig.json --noEmit` | exit **0**, no output |
| `tsc -p tsconfig.check.json` | exit **0** for every file in this slice — see the attribution note below |
| `git` version measured against | `2.55.0.windows.3` |
| `node` | `v24.18.0` |
| Commits made | **none** (per instruction) |
| `D:\DSH\src\dsh-src` modified | **no** (its pre-existing dirty files predate this session by ~8 h and are not mine) |
| Leftover temp dirs (`dsh-ver-*`, `dsh-writers-probe-*`, …) | **0** |
| Port 3080 | **not listening**; the boot probe was killed and the port verified released |
| Files changed by this pass | `src/verification-gates.test.ts` (two assertions/anchoring, both strengthened); `tests.txt`, `source-digests.txt`, `FINDINGS.md`, `writers-mounted.json` (evidence); `docs/GAPS.md` (G-VER-01..05) |

**Attribution note on `tsconfig.check.json`.** At one point during this pass that
config exited 2 with `src/research-chain.test.ts(140,3): error TS2741: Property
'headers' is missing`. That file is **not part of this slice** and was being
edited concurrently by another agent — its mtime moved `03:24:51 → 03:25:19` and
the error moved `line 140 → line 161` between two consecutive runs. **No error in
that run referenced `verification-gates.test.ts`, `worktree-isolation.ts` or
`writers-plugin.ts`.** This is reported rather than fixed, per the instruction to
attribute rather than touch another agent's file. It is a transient of concurrent
editing, not a defect in M8.


**One file was touched in the shared package config, and it was not touched by
me.** `package.json` and `cordis.patch.yml` already carried the `./writers` export
and the `daily-writers` row when this pass began; their digests are unchanged from
the pre-verify recording (`15eeeeed…` and `c424b86a…`). **This pass added nothing
to either file**, which matters because other agents are editing them.


---

## Two findings from outside this slice, folded in

**`takeContinuation` had zero production callers — VERIFIED, then FIXED by the
host owner.** I checked the claim myself: the only pre-fix callers were
`goal.test.ts` and `isolation.test.ts`. The consequence was that a managed run
never disarmed the Goal round-driver, so two continuation owners could drive one
root — while `goal.test.ts` passed, because those tests called the method
directly. **That is the same defect class as this slice's production-entry work,
one file over: the oracle was weaker than the scenario.** It is now called from
`createRun` (`982e82b`), with the handover result recorded on the run record, so
a reader can check that the durable objective and revision survived rather than
trusting that `disarm` was mild. This is why the boot probe exists here rather
than a direct-mount test.

**Three of 127 evidence hashes in `qualification/gates.json` are already stale.**
Recomputed all 127: `T05`, `T06` and `T08` cite
`qualification/results/M9.2-terminal-advanced/FINDINGS.md` at `1f1408e7…`, and the
file is now `615adaad…`. None is missing; all three point at a file that has
changed since the hash was recorded. That is a live instance of the exact class
VER-05 tests — a stored verdict that no longer describes the artifact — and it is
worth noting that the project's own gate index has it while no test covers it.

> **SUPERSEDED — this finding did NOT reproduce in the independent pass.** All
> **127** evidence hashes were recomputed from scratch: **0 missing, 0 stale.**
> `T05`, `T06` and `T08` all record `615adaad87d29e3c…` and all three match the
> file on disk. The `1f1408e7…` value above is the OLD hash, and the row had
> evidently already been regenerated before the check was re-run (consistent with
> the G-FIX-11 note about regenerating `gates.json`). The historical observation
> may have been true when made, but it is **not true now** and must not be
> carried forward as a live defect. Retained here struck through rather than
> deleted, because a claim that silently disappears is indistinguishable from a
> claim that was never made.


---

## Reproducing

```sh
cd packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/verification-gates.test.ts --maxWorkers=1 --no-file-parallelism   # 45 passed
tsc -p tsconfig.check.json                                                       # exit 0
```

```sh
cd /d/DSH/work/dsh-native-daily
node qualification/runners/acceptance.mjs qualification/results/M8-verification/def-zero-tests.json
```

```sh
cd /d/DSH/src/dsh-src
export PATH="/d/DSH/tools/bin:$PATH"
export DSH_HOME='D:\DSH\home\canary5'
node apps/cli/lib/bin.js --profile daily \
  --patch 'D:\DSH\work\dsh-native-daily\qualification\results\M8-verification\writers-mounted.patch.yml'
```

**Cleanup is verified, not assumed.** `afterAll` releases every workspace (removing
its worktree, branch and lease) and removes every kept snapshot; the boot probe
removes its own repository, workspace parent and lease in a `finally`. Checked
after a full run: `git worktree list` shows only the repository itself, and zero
directories matching `dsh-ver-*`, `dsh-acceptance-*`, `dsh-integration-*` or
`dsh-writers-probe-*` remain in the temp directory.

## Files in this directory

| File | Contents |
|---|---|
| `tests.txt` | Real vitest output for `src/verification-gates.test.ts`, `test_exit=0`, 45 passed — **re-run by the verifier after the W02 fix**. |
| `tests.stale-preverify.txt` | The superseded recording (`44 passed / 44`) preserved verbatim, so the correction is auditable. |
| `tsc.txt` | `tsc -p tsconfig.check.json`, `tsc_exit=0`, 0 diagnostics. |
| `source-digests.txt` | sha256 of the files this slice adds, plus the subject under test. **Re-derived by the verifier.** |
| `source-digests.stale-preverify.txt` | The superseded digest list, preserved. |
| `cli-transcript.txt` | Four real CLI runs: zero-tests, all-skipped, weakened-refused, stale-then-stale. |
| `w02-git-measurements.txt` | The raw git exit codes behind "a worktree is not a boundary". |
| `boot-probe.txt` | The resolved profile row and the probe's finding from inside a real boot. |
| `writers-mounted.json` | The boot probe's machine-readable finding (refreshed by the verifier's re-run; field values identical). |
| `writers-mounted.patch.yml` | The overlay that mounts the probe. |
| `receipt-*.json` | The real receipts the CLI runs produced. |
| `def-*.json` | The acceptance definitions the CLI runs used. |
| `fixture/` | The self-contained vitest fixture (an all-skipped suite and a zero-test suite). |
| `probe2.json` | The all-services presence check from the same boot. |
