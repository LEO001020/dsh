# M9.1 — protected acceptance runner (gates F01–F08)

Status: **IMPLEMENTED AND MEASURED.** Every claim below is backed by a file in
this directory produced by a real run on this machine.

## What was built

| File | Role |
|---|---|
| `packages/dsh-daily-work/src/verify.ts` | The runner: executes one acceptance definition in a child process and emits a receipt. |
| `packages/dsh-daily-work/src/verify.test.ts` | 30 tests. Every case runs a real child through the real DSH subprocess seam. |
| `qualification/runners/acceptance.mjs` | CLI: run a definition from JSON, print/check a digest, check a stored receipt, or do an expected-ref CAS. |

Source digests for this slice are in `source-digests.txt`.

## How the runner is built, and why

**It uses the real DSH subprocess seam, not `child_process`.** The child is
spawned through `ctx.subprocess.spawn(spec)`, quoted from
`packages/subprocess/subprocess/src/index.ts:153` at the pinned commit:

```ts
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
```

with `SubprocessSpawnSpec` (`src/types.ts:77`) and
`SubprocessHandle.done: Promise<SubprocessOutcome>` (`types.ts:181`). Two
properties of that seam are load-bearing here and neither is available from a
hand-rolled `spawn`:

1. **`scrubbedParentEnv()` drops credential-shaped names and every `DSH_*` name**
   before the child starts (`subprocess/src/index.ts:66`). The verifier executes
   untrusted, possibly model-modified repo code, so it must not inherit host
   credentials by virtue of being "verification" (INV-S6).
2. **`waitForExit()` observes the managed process RANGE**, not just the direct
   child (`types.ts:195`). A timeout must be able to prove it left nothing
   behind, and a direct-child-only view cannot.

**The timeout is our own flag, never inferred from the exit code.** Measured on
this machine: aborting a running child through the local provider settles as
`{ exitCode: 1, signal: null }` — a plain non-zero code, no signal at all. A
verifier that classified timeouts by looking for a signal would report every
timeout as an ordinary failure and hide the fact that the outcome is *unknown*.
The seam's own comment on `signal` states the division of labour this relies on:
*"The caller owns deadlines and cause classification; this seam only reacts to
the abort."*

**The receipt records what is observed, and nothing else.** A missing command
leaves `exit.code` as `null` rather than a convenient `0`. `command_not_found`,
`zero_tests`, `all_skipped` and `runner_never_ran` are distinct outcomes rather
than one bucket, because they are different failures and a reader has to be able
to tell them apart.

## The outcome vocabulary

Only `pass` is a PASS. Every one of these was produced by a real run:

| Outcome | Meaning |
|---|---|
| `pass` | Real exit code matched AND every declared count matched. |
| `fail` | The command really ran and really exited off the expected code. |
| `command_not_found` | The executable could not be resolved. Nothing ran. |
| `timeout` | Our deadline fired. **UNKNOWN**, and the reservation is held. |
| `interrupted` | An external stop. **UNKNOWN**, and the reservation is held. |
| `zero_tests` | A runner reported a total of zero executed tests. |
| `all_skipped` | A runner reported tests and none passed or failed. |
| `runner_never_ran` | Counts were declared and no runner summary appeared. |
| `count_mismatch` | Observed counts disagree with the declared ones. |
| `unknown` | No exit code, or the snapshot moved under the run. |
| `acceptance_definition_changed` | The definition digest does not match the authorized one. Refused to run. |

## What the evidence proves

### F01 — a completion claim is never the oracle

No model claim is an input to this runner. The verdict comes from a real child's
exit code and a real runner's summary. `receipt-pass.json` shows a genuine PASS:
`exit.code` 0, `observedTests` `{total: 30, passed: 30}`, both read from the
child. The `command_not_found` case shows the converse — nothing ran, so there is
no exit code to report and none is invented.

### F02 — no command, all-skipped, runner-never-ran and zero tests are all non-PASS

This is the sharpest result in the slice, because two of these cases have a
**real exit code of 0**:

- `receipt-all-skipped.json`: the child really exited 0, and the runner reports
  `total=1 passed=0 failed=0 skipped=1`. Classified `all_skipped`, `passed: false`.
- The zero-test case (`--passWithNoTests`, vitest printing `Tests  no tests`)
  also exits 0 and is classified `zero_tests`, `passed: false`.

An exit-code-only verifier would call both of these green. That is precisely the
failure this gate exists to prevent, and it is demonstrated rather than asserted.

### F03 — receipt freshness

`staleness.txt` is a real three-step run: a receipt is written, `--check` accepts
it while the tree is unchanged (`fresh: true`, exit 0), one byte of an input
changes, and `--check` then reports `fresh: false` and exits 1. A receipt is a
statement about a tree digest, so it cannot outlive the tree.

### F04 — A→B→A is caught by the immutable snapshot

`verify.test.ts` runs the mutation **concurrently with** the acceptance, on a
schedule written out in the test: the tree goes A→B at t=700ms, the child reads
its input at t=1200ms, the tree returns to A at t=1900ms, and the child exits at
t=2800ms so the runner's end digest is taken after the mutation window has
closed.

The test has two arms, and the second is what makes the first meaningful:

| Arm | What the child saw | Live digests | Verdict |
|---|---|---|---|
| Snapshot | A (its own copy) | start == end, `liveDriftDetected: false` | PASS, correctly |
| In place | B — and it **exited 9** with `SAW_THE_TAMPERED_TREE` | start == end, drift undetected | FAIL, correctly |

The in-place arm is the proof that the snapshot is load-bearing: before/after
hashing reports *no drift at all* while the command really did execute against
the tampered tree. Endpoint hashing is not sufficient, and the snapshot is what
closes it.

A second case covers the one way a snapshot can stop describing one tree: a
command that rewrites its own declared input inside the snapshot while running.
That yields `unknown` and holds the reservation, not a pass.

### F05 — a weakened acceptance cannot go quietly green

The definition carries the digest it is authorized to have. Lowering a declared
threshold changes `acceptanceDefinitionDigest`, and a definition whose declared
digest does not match is **refused** (`acceptance_definition_changed`) rather
than executed. `--print-digest` is a separate step on purpose: a definition
cannot authorize itself in the same breath as it is written.

### F07 — the retry budget is bounded and ends blocked

`runAcceptanceWithBudget` retries only environment-shaped outcomes
(`timeout`/`unknown`/`interrupted`). A candidate defect is not retried at all
(one attempt, status `failed`). When the budget is spent the status is `blocked`
— it stops. It does not keep going until it passes.

### F08 — expected-ref CAS

`refCas` reads a ref and compares it with the sha the candidate was verified
against. It has **no write path**: there is no force, reset or update anywhere in
it. A ref that moved, or a ref that cannot be read, is a refusal. Tested against
a real temporary git repository, including the unreadable-ref case.

### Security: the untrusted child does not inherit host privilege

Tested by setting canary variables in the runner process and reading them back
from inside the acceptance command. Credential-shaped names
(`*_FAKE_API_KEY`, `*_FAKE_TOKEN`) and every `DSH_*` name are `null` in the
child; an ordinary marker survives. This is the seam's `scrubbedParentEnv()`
doing the work, and the test proves the denial path.

## What is NOT proven

Stated plainly, because a verification authority that overstates its coverage is
worse than one with a smaller claim.

1. **The snapshot is not a sandbox.** It is an immutable *input* copy, not an
   execution jail. A command in the snapshot can still read and write the host
   filesystem, reach the network, and see other processes. Nothing here confines
   egress; `G-SEAM-12` records that Windows sandboxing is write-only and
   `enforcement: 'partial'`, and this slice does not change that. The isolation
   claimed here is exactly two things: no inherited credentials, and a managed
   process range that is terminated as a range.

2. **`node_modules` is outside the digest.** It is junctioned into the snapshot
   so the toolchain can resolve, and the receipt says so in
   `snapshot.coverage`. A change to a dependency is therefore not covered by
   `candidateTreeDigest`. The declaration covers source inputs, not the
   dependency closure.

3. **Digest coverage is whatever the definition declares.** If `inputs` omits a
   file that actually affects the result, the digest will not notice it changing.
   The receipt states this (`coverage`), and a declared input that is absent is
   listed in `limitations` rather than silently skipped. There is no claim of
   whole-repository coverage.

4. **`managedRangeEmpty: true` is an observation, not a proof of resource
   release.** The seam documents that providers differ in what they can observe.
   Where the range cannot be observed to quiesce the field is `'unknown'`, and
   that is reported rather than rounded to success.

5. **F08 is a read-only CAS, not an integration system.** This project does not
   merge. `refCas` answers "does this ref still point where it did"; it does not
   create commits, push, or gate a real merge queue.

6. **No live model is involved.** These tests drive the runner directly. They
   prove the runner's classification is honest; they do not prove that a model
   would be *stopped* by it. Wiring the runner into a turn-stopping hook is gate
   F06, which remains `NOT_RUN` — no turn-stopping hook is registered by this
   project, and the delivery plan says to add one only when a measured early-stop
   gap or an externally consumable proof requires it.

7. **The `all_skipped`/`zero_tests` detection depends on the runner printing a
   summary.** Two summary grammars are implemented (`vitest`, `node-test`) and
   both are tested against their real output. A third-party runner with a
   different summary format would need a parser added, and until then its output
   reads as `runner_never_ran` — which is non-PASS, so the failure mode is safe
   but would need attention.

## Reproducing

```sh
cd packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run src/verify.test.ts          # 30 passed
/d/DSH/src/dsh-src/node_modules/.bin/tsc -p tsconfig.json --noEmit   # exit 0
```

```sh
cd /d/DSH/work/dsh-native-daily
node qualification/runners/acceptance.mjs <definition.json> --out <receipt.json>
```

## Files in this directory

| File | Contents |
|---|---|
| `tests.txt` | Real vitest output for `src/verify.test.ts`, with `test_exit=0`. |
| `test-case-index.txt` | The 30 test names, colour codes stripped. |
| `tsc.txt` | `tsc_exit=0`. |
| `cli-transcript.txt` | Real CLI runs: one PASS, three NOT-PASS paths, and the exit-code contract. |
| `staleness.txt` | The fresh → stale receipt check. |
| `receipt-pass.json` | A real PASS receipt for the package's own suite. |
| `receipt-all-skipped.json` | A real NOT-PASS receipt whose child exit code was 0. |
| `receipt-timeout.json` | A real timeout receipt, showing `holdReservation: true`. |
| `source-digests.txt` | sha256 of the three files this slice adds. |
| `fixture-all-skipped/` | The self-contained all-skipped fixture used by the CLI transcript. |
