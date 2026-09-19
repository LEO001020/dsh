# P1 — Full-Suite Triage

**Role:** P1, reporter only. No source or test file was edited by this agent.
**Package:** `packages/dsh-daily-work` · **Repo:** `D:\DSH\work\dsh-native-daily` (branch `ipython-native`)
**Runner:** `export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"` then `vitest run`
**Vitest:** v4.1.8

> **THIS IS A MOVING-TREE SNAPSHOT.** Nine other agents were editing `src/**` concurrently
> throughout. Every run below is a snapshot of a different revision. Per-run tree digests are
> recorded in "Tree digests" so a later reader can tell whether a result still applies.

---

## 0. Headline

The suite **does complete** — it printed a `Test Files`/`Tests` summary on all four full runs.
The previous "died without printing a summary" symptom did **not** reproduce here.

| Run | Started | Files | Tests | Exit |
|---|---|---|---|---|
| run1 | 02:48:32 | 2 failed \| 45 passed (47) | 10 failed \| 1063 passed (1073) | 1 |
| run2 | 03:17:09 | 2 failed \| 45 passed (47) | 8 failed \| 1078 passed (1086) | 1 |
| run3 | 03:25:16 | 2 failed \| 44 passed (46) | 2 failed \| 1087 passed (1089) | 1 |
| **run4** | **03:32:35** | **46 passed (46)** | **1103 passed (1103)** | **0** |

The failure set changed completely between runs because other agents were fixing things
concurrently. **run4 is the authoritative current number: the suite is GREEN.**
run1–run3 are retained because the classifications (TIMEOUT vs ASSERTION vs load-dependent)
are the deliverable and they are revision-specific — they document *what was wrong* and
*how it was classified*, which is what tells a reader whether a given green result is real.

**Read this before trusting the green:** one finding survives run4 and is *not* cleared by it.
`src/isolation.test.ts` is byte-identical across run3, run4 and the present tree, and it **failed
in run3's full suite, passed in run4's full suite, and passed alone** — a timing-sensitive oracle
(fixed 400 ms sleep, then `expect(...).toBeGreaterThan(0)`) that is intermittent under load. See
§5. A single green suite run does not clear it, and it will flake again on a loaded machine.

**Also not cleared by run4:** the suite was green at digest `5976de6b…` only. The tree moved after
run4 (`HEAD` `08c08b7` → `0751e9d`), so run4's green is a snapshot, not a standing guarantee.
See §9 for the digests and §10 for the full list of what I could not determine.

---

## 1. run4 — authoritative (current revision)

**The suite is GREEN.** Exit code `0`.

Command:

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run
```

**Summary lines, verbatim:**

```
 Test Files  46 passed (46)
      Tests  1103 passed (1103)
   Start at  03:32:35
   Duration  127.97s (transform 34.60s, setup 0ms, import 49.62s, tests 659.35s, environment 7ms)
```

**Failing test files: none.** Zero `×` lines in the entire output.

**Files that timed out: none.** Zero occurrences of `Test timed out in 60000ms`.

**Files that do not parse: none.** All 46 declared files produced results.

Internal consistency check: 46 declared test files == 46 files reported, and the per-test count
reconstructed from the verbose lines (`1103`) matches the reported total exactly. So no file was
silently skipped and no file failed to load.

### Caveat on run4: the tree moved during its own window

Run4 ran 03:32:35 → 03:34:43. Two test files were edited **during** that window:

| File | mtime | Status |
|---|---|---|
| `src/data-plane.test.ts` | 03:33:23 | edited mid-run |
| `src/research-chain.test.ts` | 03:33:11 | edited mid-run |

I re-ran **both together at their post-edit revision** (`iso-changed-during-run4.txt`):
**2 files passed, 75 tests passed, `EXIT=0`**. So the edits did not break them, but strictly
speaking run4's green covers a mix of pre- and post-edit revisions for these two files. Every
other file in run4 was byte-stable across its window.

This is the honest limit of a green result taken on a moving tree: it is green at the digest
recorded, and the two mid-window edits were independently confirmed green afterwards.

---

## 2. run1 — original full run (baseline, tree digest `08fb925c…`)

Command (exactly as issued):

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run > /tmp/p1-full.txt 2>&1; echo "EXIT=$?" >> /tmp/p1-full.txt
```

**Exit code:** `1`

**Summary lines, verbatim:**

```
 Test Files  2 failed | 45 passed (47)
      Tests  10 failed | 1063 passed (1073)
   Start at  02:48:33
   Duration  481.67s (transform 27.25s, setup 0ms, import 43.79s, tests 998.73s, environment 6ms)
```

All 47 declared test files reported. `47 declared == 47 reported`, and the per-test count
reconstructed from the verbose lines (`1073`) matches the summary exactly — so **nothing was
silently dropped and no file failed to load**.

### Failing test files (run1)

| File | Pass / Fail | Failure reason (verbatim, trimmed) | Class |
|---|---|---|---|
| `src/eco.test.ts` | 35 pass / **1 fail** | `AssertionError: expected 'c9992160f9838f3bcdec19e62d6d6c7413305…' to be '547a59b2d1661bb4c0666e8bad46eafb4c9f4…'` | ASSERTION |
| `src/kernel-recovery.test.ts` | 54 pass / **9 fail** | 8 × `Error: Test timed out in 60000ms.` + 1 × `AssertionError: expected 1000 to be greater than 1000` | TIMEOUT (8) + ASSERTION (1) |

### Classification of every run1 failing test

`TIMEOUT` = hit the 60 s bound · `ASSERTION` = real assertion mismatch ·
`IMPORT/PARSE` = file does not load · `OTHER`

| # | Test | Elapsed | Class |
|---|---|---|---|
| 1 | `eco.test.ts > ECO-07 > the stock arm declares no plugin rows, and its files hash to the committed values` | 24 ms | **ASSERTION** |
| 2 | `kernel-recovery > an interrupt that does not settle… > escalates to process isolation on a non-interruptible C extension, and says so` | 60015 ms | **TIMEOUT** |
| 3 | `kernel-recovery > an interrupt that does not settle… > reports the restart loss: the namespace is gone and the loss is named` | 60001 ms | **TIMEOUT** |
| 4 | `kernel-recovery > an interrupt that does not settle… > refuses further cells on a kernel that could not be restarted` | 60008 ms | **TIMEOUT** |
| 5 | `kernel-recovery > unknown side effects stay quarantined > keeps an in-flight cell with no confirmed terminal state quarantined` | 60008 ms | **TIMEOUT** |
| 6 | `kernel-recovery > unknown side effects stay quarantined > does NOT re-execute an ambiguous call when the transport reconnects` | 60003 ms | **TIMEOUT** |
| 7 | `kernel-recovery > unknown side effects stay quarantined > clears a quarantine only through an explicit, evidenced resolution` | 60004 ms | **TIMEOUT** |
| 8 | `kernel-recovery > reset and permission change… > MUST restart on a read-permission-domain change, and must not carry variables across` | 1 ms | **ASSERTION** (`expected 1000 to be greater than 1000`) |
| 9 | `kernel-recovery > reset and permission change… > cancels the running cell before replacing the process` | 60005 ms | **TIMEOUT** |
| 10 | `kernel-recovery > recovery reports state honestly… > reports epoch, as-of, restored, lost, environment change and unresolved effects` | 60014 ms | **TIMEOUT** |

### Files that timed out (run1) — a hang is a different bug class from a wrong assertion

All 8 in `src/kernel-recovery.test.ts`, each at the 60 s bound:

| Test | Elapsed |
|---|---|
| escalates to process isolation on a non-interruptible C extension, and says so | 60015 ms |
| reports the restart loss: the namespace is gone and the loss is named | 60001 ms |
| refuses further cells on a kernel that could not be restarted | 60008 ms |
| keeps an in-flight cell with no confirmed terminal state quarantined | 60008 ms |
| does NOT re-execute an ambiguous call when the transport reconnects | 60003 ms |
| clears a quarantine only through an explicit, evidenced resolution | 60004 ms |
| cancels the running cell before replacing the process | 60005 ms |
| reports epoch, as-of, restored, lost, environment change and unresolved effects | 60014 ms |

### Files that do not parse

**None.** Every one of the 47 declared test files produced at least one test result, and the
reconstructed test total equals the reported total. No `IMPORT/PARSE` failure occurred in run1.
(A compile error did appear later, in run3 — see §4 — but it surfaced through `dep-gates`, not
as a load failure.)

### run1 root causes (as established from the source at that revision)

**eco.test.ts — stale pinned digest.** `ECO-07` asserts that
`profiles/daily-candidate/cordis.patch.yml` hashes to the digest M0.5 recorded
(`547a59b2d1661bb4c0666e8bad46eafb4c9f4b771436c0bcf8e6b09873d5a7b1`); the file on disk hashed
to `c9992160f9838f3bcdec19e62d6d6c7413305174f00a4fcab8eae1f797e906a8` in run1 and
`2a0aff17ba2112e80c15784493ea220bced31abb1f26759f954546163750a3cf` later.
**The coordinator has confirmed this failure was caused by their own edit to that profile** —
the profile legitimately changed and the pinned digest correctly caught it. This is the gate
working as designed, not a product bug. Fixed in commit `a1d6e6d`; verified by this agent:
the pin now reads `2a0aff17…` and matches the file byte-for-byte.

**kernel-recovery.test.ts — test-drive bug (wall bound and interrupt grace are two SEQUENTIAL
bounds).** The hanging tests advance the injected clock once and then `await` the cell promise.
The wall-bound timer responds by *dispatching an interrupt*, which is an async transport call,
so the grace timer is armed on a **later microtask** than the synchronous `advance()` that fired
the wall bound. Advancing once therefore leaves the grace timer unarmed, the cell never settles,
and the test hangs to the 60 s bound. The sibling test
`resolves a cell whose transport promise NEVER settles at all` documents exactly this and
passes — it uses the two-advance shape (`await r.flush()` between `advance(wall)` and
`advance(grace)`). This is a **test-drive bug, not a product bug**, and it is consistent with
the observation that the product code does implement every API these tests exercise
(`restartLosses`, `breachLog`, `changeReadPermissionDomain`, `runCell`, `noteBinding`,
`escalateToProcessIsolation` all exist in `kernel-lifecycle.ts`).
The one non-timeout failure in this group —
`expected 1000 to be greater than 1000` at `kernel-recovery.test.ts:1076` — is the same class:
the assertion checks that a restart really replaced the process (`pid` advanced), and the pid
never advanced because the restart path was never reached.

---

## 3. run2 (tree digest `0bf3fa2f…`, HEAD `a1d6e6d`)

**Exit code:** `1`

**Summary lines, verbatim:**

```
 Test Files  2 failed | 45 passed (47)
      Tests  8 failed | 1078 passed (1086)
   Start at  03:17:09
   Duration  301.58s (transform 22.70s, setup 0ms, import 38.36s, tests 871.61s, environment 7ms)
```

This run was launched specifically to confirm the coordinator's eco fix. `eco.test.ts` is
**gone from the failing set** — confirmed fixed. A *different* set of 8 failed.

### Failing test files (run2)

| File | Pass / Fail | Failure reason (verbatim, trimmed) | Class |
|---|---|---|---|
| `src/kernel-recovery.test.ts` | 56 pass / **7 fail** | 6 × `Error: Test timed out in 60000ms.` + 1 × `AssertionError: expected true to be false` | TIMEOUT (6) + ASSERTION (1) |
| `src/zz-m5-trace.test.ts` | 2 pass / **1 fail** | `AssertionError: expected true to be false // Object.is equality` at `zz-m5-trace.test.ts:117` | ASSERTION |

### run2 failing tests, classified

| # | Test | Elapsed | Class |
|---|---|---|---|
| 1 | `kernel-recovery > … > refuses further cells on a kernel that could not be restarted` | 8 ms | **ASSERTION** (`expected true to be false`) |
| 2 | `kernel-recovery > unknown side effects stay quarantined > keeps an in-flight cell with no confirmed terminal state quarantined` | 60010 ms | **TIMEOUT** |
| 3 | `kernel-recovery > unknown side effects stay quarantined > does NOT re-execute an ambiguous call when the transport reconnects` | 60008 ms | **TIMEOUT** |
| 4 | `kernel-recovery > unknown side effects stay quarantined > clears a quarantine only through an explicit, evidenced resolution` | 60007 ms | **TIMEOUT** |
| 5 | `kernel-recovery > reset and permission change… > MUST restart on a read-permission-domain change, and must not carry variables across` | 1 ms | **ASSERTION** (`expected 1000 to be greater than 1000`) |
| 6 | `kernel-recovery > reset and permission change… > cancels the running cell before replacing the process` | 60002 ms | **TIMEOUT** |
| 7 | `kernel-recovery > recovery reports state honestly… > reports epoch, as-of, restored, lost, environment change and unresolved effects` | 60013 ms | **TIMEOUT** |
| 8 | `zz-m5-trace > TRACE2 > trace: interrupt() that never resolves leaves runCell unresolved (product gap)` | 9 ms | **ASSERTION** |

**Progress between run1 and run2:** the two escalation tests
(`escalates to process isolation…`, `reports the restart loss…`) were fixed by another agent and
now pass. That reduced kernel-recovery from 9 failures to 7.

### The `zz-m5-trace.test.ts` failure — the assertion was *stale*, and the file has since been deleted

This was a **diagnostic/trace** file, not a product test. Its failing assertion
`expect(resolved).toBe(false)` at line 117 encoded the claim "a product gap: an `interrupt()`
that never resolves leaves `runCell` unresolved". Its own diagnostic stdout from run2 shows the
opposite:

```
INTERRUPT NEVER RESOLVES:
   (no due timers; pending=2@1002000)
   (no due timers; pending=)
pending= resolved=true interrupts=1 restarts=1
```

`resolved=true` and `restarts=1` — i.e. `runCell` **did** resolve and the kernel **did** restart,
which is the desired behaviour. The trace file's neighbouring cases had already demonstrated the
real mechanism (`trace: sync advance cannot reach a grace armed across an await; an async advance
can`). The file was **deleted from the tree by another agent** after run2 (confirmed: it is absent
now, and the declared test-file count dropped 47 → 46). This failure is therefore **resolved by
deletion and no longer applicable**. Recorded here because "the test that documented the gap now
fails because the gap is closed" is easy to misread as a regression.

---

## 4. run3 (tree digest `879024d7…`, HEAD `1e0b8d6`)

**Exit code:** `1`

**Summary lines, verbatim:**

```
 Test Files  2 failed | 44 passed (46)
      Tests  2 failed | 1087 passed (1089)
   Start at  03:25:16
   Duration  129.04s (transform 33.89s, setup 0ms, import 53.72s, tests 708.16s, environment 13ms)
```

Note the file count is now **46** (down from 47): `zz-m5-trace.test.ts` was deleted.
**All 7 kernel-recovery failures from run2 are gone** — another agent fixed them, and this agent
independently confirmed `kernel-recovery.test.ts` now passes **64/64 in isolation** on the
revision that followed (digest `03797887…`, `EXIT=0`).

### Failing test files (run3)

| File | Pass / Fail | Failure reason (verbatim, trimmed) | Class |
|---|---|---|---|
| `src/dep-gates.test.ts` | 36 pass / **1 fail** | `AssertionError: the whole tree must compile clean: src/research-chain.test.ts(161,3): error TS2741: Property 'headers' is missing in type '{ base: string; requests: string[]; searches: … }' but required in type 'Origin'.` | **OTHER** (typecheck gate; see note) |
| `src/isolation.test.ts` | 38 pass / **1 fail** | `AssertionError: expected 0 to be greater than 0` at `isolation.test.ts:909` | ASSERTION |

### Classification notes

**`dep-gates.test.ts` is `OTHER`, not ASSERTION in the ordinary sense.** The assertion is a
typecheck gate (`DEP-03`) that shells out to `tsc` over the whole tree and asserts zero errors.
The error it reported is a **real type error in a *different* file**,
`src/research-chain.test.ts:161` — an object literal missing the `headers` property required by
its own local `Origin` interface. So the true defect locus was `research-chain.test.ts`, and
`dep-gates.test.ts` was merely the messenger. **This has since been fixed**: at the time of the
isolation re-run the `origin()` helper returns all four fields
(`return { base: …, requests, searches, headers }`) and `dep-gates.test.ts` passes **37/37 in
isolation** (`EXIT=0`).

**`isolation.test.ts` — LOAD-DEPENDENT, and this is the single most interesting finding.**
Its digest is **identical** before and after (`7e70a6a5e34430b901b28e479f5e3e72db0bbb81dfd469fbb1e372d0968cd7a1`)
— the file did not change between the in-suite failure and the isolation pass. It failed in the
full suite (0 requests observed where >0 expected, at `isolation.test.ts:909`) and passed
**39/39 in isolation** (`EXIT=0`) on the byte-identical file. That is the signature of a
**resource/interference bug under full-suite load**, not a broken test and not a stale pin.
The assertion is timing-sensitive by construction — it waits a fixed 400 ms
(`await new Promise(resolve => setTimeout(resolve, 400))`) and then expects the disarmed driver
to have queued at least one round. Under a suite that is running 45 other files in parallel with
real subprocesses (python, pwsh, git), 400 ms of wall clock can elapse without the async
continuation machinery getting scheduled.

Caveat, stated honestly: I could not re-confirm this under a *second* full-suite run on the
identical digest, because the tree kept moving. The evidence is "same bytes, fails loaded /
passes isolated", which is strong but rests on one in-suite observation.

---

## 5. Load-dependence summary (the "alone vs under load" separation)

| Test file | Full suite | In isolation | Same digest? | Verdict |
|---|---|---|---|---|
| `eco.test.ts` | 1 fail | 1 fail (36 tests, `EXIT=1`) | yes | **Fails on its own.** Real assertion; caused by coordinator's profile edit, since fixed. |
| `kernel-recovery.test.ts` | 9 fail (run1) | 9 fail (63 tests, `EXIT=1`) | yes | **Fails on its own.** Not load-dependent. Test-drive bug. |
| `kernel-recovery.test.ts` | 7 fail (run2) | 7 fail (63 tests, `EXIT=1`) | yes | **Fails on its own.** Same class. |
| `kernel-recovery.test.ts` | 0 fail (run3/4) | 0 fail (64 tests, `EXIT=0`) | n/a | Fixed by another agent; independently confirmed green. |
| `zz-m5-trace.test.ts` | 1 fail (run2) | not run — file deleted before isolation | no | Stale diagnostic assertion; file removed. |
| `dep-gates.test.ts` | 1 fail (run3) | 0 fail (37 tests, `EXIT=0`) | yes | **Messenger for a cross-file type error**; real error was in `research-chain.test.ts`, since fixed. |
| `isolation.test.ts` | 1 fail (run3) | 0 fail (39 tests, `EXIT=0`) | **yes (identical digest)** | **LOAD-DEPENDENT / INTERMITTENT.** Same bytes failed loaded, passed loaded, passed alone. |
| `data-plane.test.ts` + `research-chain.test.ts` | 0 fail (run4, but edited mid-window) | 0 fail (75 tests, `EXIT=0`) | edited mid-run | Edits confirmed green afterwards. |

**The one genuine load-dependent finding is `isolation.test.ts`.** Everything else either fails
identically in isolation (a real bug or a real stale pin) or was fixed mid-flight.

### `isolation.test.ts` — the strongest single finding

This file is byte-identical (`7e70a6a5e34430b901b28e479f5e3e72db0bbb81dfd469fbb1e372d0968cd7a1`)
across **run3, run4, and the present tree** — it was never edited during any of my runs. Yet:

| Observation | Conditions | Result |
|---|---|---|
| run3 full suite (46 files, 44 parallel) | loaded | **FAIL** — `expected 0 to be greater than 0` at `isolation.test.ts:909` |
| run4 full suite (46 files) | loaded | **PASS** |
| isolation run | alone | **PASS** (39/39, `EXIT=0`) |

Identical bytes, three observations, two different in-suite outcomes. That is not a broken test
and not a stale pin — it is a **timing-sensitive oracle that is load-dependent**. The mechanism is
visible in the assertion itself:

```
907|     await new Promise(resolve => setTimeout(resolve, 400))
908|     const beforeHandover = r.adapter.requests.length
909|     expect(beforeHandover).toBeGreaterThan(0)
```

A fixed 400 ms wall-clock wait, then an assertion that asynchronous continuation machinery has
produced at least one request. Under a suite running 45 other files in parallel — several of which
spawn real python, pwsh and git subprocesses — 400 ms of wall clock can pass without the
continuation being scheduled. Under a lighter load it does not. **A repair agent should not
"fix" this by relaxing the assertion to `toBeGreaterThanOrEqual(0)`; that would make it vacuous.
The fix is to await the condition rather than sleep a fixed interval.**

This is a third failure category worth naming, distinct from both "fails alone" and "fails under
load deterministically": **intermittent-under-load**. A single green run does not clear it.

Note also that the run3 `dep-gates` failure is a **load-independent cross-file** dependency: the
typecheck gate reads the whole tree, so a defect in one file fails a different file's test. That
is a distinct third category from both "fails alone" and "fails under load", and it is the one
that most easily misdirects a repair agent at the wrong file.

---

## 6. Timeout (hang) list — all runs

Every timeout observed was exactly at the 60 000 ms bound, and **all of them were in
`src/kernel-recovery.test.ts`**. No other file in any run hung.

| Run | File | Tests that hung | Elapsed |
|---|---|---|---|
| run1 | `kernel-recovery.test.ts` | 8 | 60001–60015 ms |
| run2 | `kernel-recovery.test.ts` | 6 | 60002–60013 ms |
| run3 | — | **0** | — |
| run4 | — | **0** | — |

Root cause of every hang: the two-sequential-bounds test-drive bug described in §2. Once another
agent fixed those tests, the hangs disappeared entirely — run3 and run4 both had **zero**
timeouts, and the suite's total duration dropped from 481 s (run1) to 128 s (run4) once the
60 s hangs were gone.

---

## 7. IMPORT/PARSE failures — all runs

**None, in any run.** No test file ever failed to load. Specifically:

- All 47 declared files produced results in run1 and run2; all 46 in run3 and run4.
- The reconstructed per-test total matched the reported total in every run
  (run1 `1073`, run2 `1086`, run3 `1089`, run4 `1103`), so no file was silently skipped.
- The one compile error that did occur (`research-chain.test.ts:161`, run3) surfaced through the
  `dep-gates` typecheck gate as a normal assertion failure — it did **not** prevent that file's
  own tests from running and passing.

This matters because a syntax error is easy to mistake for "no failures": a file that never
loads contributes no `×` lines. I checked for it explicitly in every run by reconciling declared
files against reported files, and it did not occur.

---

## 8. `BLOCKED_EXTERNAL` (live provider budget not authorized)

`live_provider_budget_authorized` is `false`. No test requiring a live model provider was run or
faked. The suite reports these honestly as passes that *assert the block itself*:

- `upg-gates.test.ts > UPG-07: real 30-provider run — BLOCKED_EXTERNAL, with the exact reason >
  the budget lock records 'live_provider_budget_authorized: false'`
- `eco.test.ts > ECO-07 … (live half BLOCKED_EXTERNAL) > fixes the controlled variables and
  records that the live comparison is BLOCKED_EXTERNAL`
- `eco.test.ts > ECO-08 … (live half BLOCKED_EXTERNAL) > …` (3 tests)

12 `BLOCKED_EXTERNAL` occurrences appear in the run1 output; all are either passing tests or
part of test/describe names. **No `BLOCKED_EXTERNAL` item is reported as a failure**, and nothing
in the failing set requires a live provider. No credential value was printed or recorded.

---

## 9. Tree digests (so a later reader can tell whether a result still applies)

A digest of the whole `src/**/*.ts` set, computed as:

```
find packages/dsh-daily-work/src -name '*.ts' -exec sha256sum {} \; | sort -k2 | sha256sum
```

| Run | Tree digest | HEAD | Test files | Notes |
|---|---|---|---|---|
| run1 | `08fb925c0a101a849e1b5d9d1a6898306ce28e85a8f206b43b186702c2a3b87f` | (pre-`a1d6e6d`) | 47 | baseline; 10 failures |
| run2 | `0bf3fa2f20a27e93b498eb39d5351d66072726e0e8ffca70e43a9dc2ebeb6618` | `a1d6e6d` | 47 | eco fix confirmed; 8 failures |
| run3 | `879024d72130fe3256975d455fb79ec5130fe272e5ff08126027d8c0039e3f5e` | `1e0b8d6` | 46 | zz-m5-trace deleted; kernel-recovery green; 2 failures |
| **run4** | **`5976de6bfd85af801e4e90a80e48552076053cdbed16d1368c1b48f122ecd455`** | `08c08b7` | 46 | **authoritative: GREEN, 1103/1103, exit 0** |
| (final) | `2194a3b0e4eee26b9d9f5621f8d5c052287b4167230719882b3eceed09a5c2a2` | `0751e9d` | 46 | tree as of this agent's last check (run4's two mid-window edits landed) |

Per-file digests are in `source-digests-run1.txt` (run1 revision) and `source-digests.txt`
(**run4 revision** — the revision the authoritative green result was measured against). The
`(final)` digest is the tree *after* run4; its only drift from run4 is the two test files edited
during run4's window, which were independently re-run green (see §1).

**Files that changed between run3 and run4:** `artifacts.ts`, `kernel-lifecycle.ts`,
`kernel-recovery.test.ts`, `research-chain.test.ts`, `upg-gates.test.ts`,
`verification-gates.test.ts`, plus the deletion of `zz-m5-trace.test.ts`.

**Files that changed between run4 and final:** `data-plane.test.ts`, `research-chain.test.ts`.

### Run-log provenance

The raw full-run logs were originally written to `/tmp` (`p1-full.txt` … `p1-full4.txt`), which is
outside this directory and not durable. They have been **copied in here** so the evidence
survives:

| File | Contents |
|---|---|
| `run1-full-suite.log` | **complete raw output** of run1, incl. verbatim summary + `EXIT=1` |
| `run2-full-suite.log` | **complete raw output** of run2, incl. verbatim summary + `EXIT=1` |
| `run3-full-suite.log` | **complete raw output** of run3, incl. verbatim summary + `EXIT=1` |
| `run4-full-suite.log` | **complete raw output** of run4 (GREEN), incl. verbatim summary + `EXIT=0` |
| `per-file-counts-run2.txt` | per-file pass/fail counts, run2 |
| `per-file-counts-run4.txt` | per-file pass/fail counts, run4 |
| `source-digests-run1.txt` | per-file sha256 at run1 |
| `source-digests.txt` | per-file sha256 at run4 (the revision the green result was measured on) |
| `iso-eco.txt` | `eco.test.ts` alone (run1 revision) — 1 failed / 35 passed |
| `iso-eco-rerun.txt` | `eco.test.ts` alone, post-fix revision — 1 failed / 35 passed |
| `iso-kernel-recovery.txt` | `kernel-recovery.test.ts` alone (run1 revision) — 9 failed / 54 passed |
| `iso-kernel-recovery-rerun.txt` | `kernel-recovery.test.ts` alone (run2 revision) — 7 failed / 56 passed |
| `iso-kernel-recovery-postrun2.txt` | `kernel-recovery.test.ts` alone (post-fix) — **64 passed, EXIT=0** |
| `iso-zz-m5-trace.txt` | `zz-m5-trace.test.ts` — file already deleted, run impossible |
| `iso-dep-gates.txt` | `dep-gates.test.ts` alone — **37 passed, EXIT=0** |
| `iso-isolation.txt` | `isolation.test.ts` alone — **39 passed, EXIT=0** |
| `iso-changed-during-run4.txt` | `data-plane.test.ts` + `research-chain.test.ts` at post-edit revision — **75 passed, EXIT=0** |
| `git-status.txt`, `git-status-run2.txt`, `git-status-run3.txt` | `git status --porcelain` snapshots |
| `git-stash.txt` | `git stash list` — **empty** (no stashes) |
| `HEAD.txt`, `HEAD-run3.txt`, `HEAD-run4.txt`, `HEAD-final.txt` | HEAD commit per run |

All logs contain ANSI colour escapes, since `vitest` colourises its verbose output. Strip them
with `sed 's/\x1b\[[0-9;]*m//g'` to read the logs as plain text.

---

## 10. What I could NOT determine

Stated plainly, because a guessed number is worse than an honest gap:

1. **`isolation.test.ts` is intermittent-under-load, and I can now demonstrate it but not
   quantify it.** The file is byte-identical (`7e70a6a5…`) across run3, run4 and the present tree,
   and it **failed in run3's full suite, passed in run4's full suite, and passed alone**. Same
   bytes, three observations, two in-suite outcomes. That establishes load-dependence, but I
   cannot give a failure *rate*: I only have one failing in-suite observation, and I did not run
   the suite repeatedly on a frozen digest to measure how often it flakes. Its fixed 400 ms
   `setTimeout` followed by `expect(...).toBeGreaterThan(0)` is the mechanism. Note that another
   agent's commit `0751e9d` ("fix a load-dependent oracle inside the verification suite itself")
   independently found and fixed a **different** load-dependent oracle in
   `verification-gates`/`verify`, which corroborates that this suite contains multiple
   timing-anchored oracles of the same shape.

2. **run1's exact revision is not identified by commit.** run1 began at 02:48:32 while HEAD moved
   toward `a1d6e6d`; the tree digest `08fb925c…` pins the *content* precisely, but I did not
   capture HEAD at the instant run1 started.

3. **Timing measurements are not clean benchmarks.** Nine other agents were running node
   processes, subprocess-spawning tests and their own vitest runs concurrently. The `Duration`
   lines and per-test elapsed times are real but contended. run3's 129 s vs run1's 481 s reflects
   a genuinely smaller failure set (no 60 s hangs) *and* differing machine load — I cannot fully
   separate those two causes.

4. **I did not verify the *fixes* other agents made.** I re-ran and observed green, which is what
   I can attest to. I did not audit whether e.g. the kernel-recovery test fixes weakened the
   assertions rather than fixing the test drive. The green isolation run showed one more test
   than the earlier revision (64 vs 63), consistent with tests being added, but I did not diff
   the assertions.

5. **run4's green is a moving-tree snapshot, and the tree moved during it.** Two files
   (`data-plane.test.ts`, `research-chain.test.ts`) were edited inside run4's own window; both
   were re-run green afterwards (75 tests, `EXIT=0`), but strictly run4 mixes pre- and post-edit
   revisions for those two files. And the tree kept moving after run4 (`HEAD` went `08c08b7` →
   `0751e9d`). **Whether the suite is still green at the latest HEAD is not something I
   measured** — I measured green at digest `5976de6b…`. A later reader must re-check the digest
   before treating run4's number as current.

6. **I did not attempt to reproduce the original "suite died without printing a summary"
   symptom**, because it did not occur in any of my four full runs. I can only report that it did
   not reproduce; I cannot say what caused it in the earlier attempt.

---

*P1 wrote only inside `qualification/results/P1-suite-triage/`. No source or test file was
modified, no commit was made, and `D:\DSH\src\dsh-src` was not touched.*
