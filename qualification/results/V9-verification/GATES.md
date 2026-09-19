# V9 — VERIFICATION family (VER-01..VER-09), measured

**Repo:** `D:\DSH\work\dsh-native-daily`, branch `ipython-native`.
**Deployment identity these measurements were taken under:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
(verified at the start of this slice with `python qualification/results/T1-spec/verify-identity.py`
— **all 28 checks passed**).
**Pinned DSH checkout (read-only):** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`.
**Host:** Windows 10.0.26200 AMD64, Node `v24.18.0`, git `2.55.0.windows.3`.

**Labels used throughout:** `[measured]` = a command was run and its output is quoted;
`[read in source]` = the claim comes from reading a file and is **not** gate evidence on its own.

---

## 0. The one thing a reader must know before the table

**An identity drift was found while filing, and it is reported rather than absorbed.**
`deployment.inputs.trusted_local_acceptance_spec_sha256` pins the digest of
`qualification/specs/acceptance-spec.trusted-local-v1.json` — and that file is also the
**results register every family writes into**. Filing evidence into it therefore changes the
digest, which changes the identity, which invalidates the identity every other family filed
under. `[measured]` the file's digest moved from `e5b6a1d2…` to `dbe6ac01…` during this
run (12 DATA cases acquired status+evidence in that window). Full measurement and the three
possible dispositions: `identity-at-measurement.txt`.

**This slice did nothing unilateral about it.** Moving `deployment.identity` is an
owner-level decision — V1-identity's own instrument says so in its own header. This slice
recorded the identity it measured under, filed its evidence, and reports the drift. It did
**not** re-derive the identity and did **not** touch any case outside the VERIFICATION family.

---

## 1. Gate table

| case | assertion (from the spec oracle) | exact command | measured result | verdict |
|---|---|---|---|---|
| **VER-01** | a zero-test run is NOT PASS, and the reason names the condition | `node qualification/runners/acceptance.mjs qualification/results/V9-verification/defs/def-ver01-zero-tests.json --out …/receipt-ver01-zero-tests.json` | `[measured]` `exit.code=0` **and** `outcome='zero_tests'` **and** `passed=false`; reason `"the runner executed zero tests, so a green exit code proves nothing"`; `acceptance_exit=1`. In-suite CONTROL: the same command with no declared counts gets `outcome='pass'` | **PASS** |
| **VER-02** | an all-skipped run is NOT PASS, skip count reported, exit was 0 | same runner, `def-ver02-all-skipped.json` | `[measured]` `exit.code=0`, `outcome='all_skipped'`, `passed=false`, `observedTests={total:2,passed:0,failed:0,skipped:2,todo:0}`; `acceptance_exit=1` | **PASS** |
| **VER-03** | the candidate cannot weaken its own oracle | `--print-digest` (step 1), then run the weakened definition (step 2) | `[measured]` `outcome='acceptance_definition_changed'`, `exit.code=null`, `limitations=["the acceptance command was never executed"]`; the refusal names both digests. CONTROL: the honest definition with the same digest **runs** | **PASS** |
| **VER-04** | a receipt does not outlive the tree it describes | `--check` before and after changing a declared input | `[measured]` fresh→`{fresh:true}` `check_exit=0`; after one byte of `src/pass.test.ts` changes → `{fresh:false, reason:"the candidate tree changed since the receipt was written (receipt 19ef6bf9…, now 9e4332f7…)"}` `check_exit=1`. CONTROL: a FRESH receipt that is not a PASS still exits 1 | **PASS** |
| **VER-05** | A-B-A during acceptance is caught; endpoint hashing alone would have certified the tamper | `node qualification/results/V9-verification/ver05-06-aba-and-inflight.mjs` | `[measured]` snapshot arm: child read revision **A** for input+oracle+config, `liveDigestAtStart == liveDigestAtEnd`, `liveDriftDetected=false`; control arm **exits 9** with `SAW_THE_TAMPERED_TREE`; both receipts carry the **same** start digest, and only the snapshot arm carries `liveDigestAtEnd`/`liveDriftDetected` | **PASS** |
| **VER-06** | in-flight writers converged or isolated before freezing; unresolved ⇒ unknown, never certified | same probe, in-flight section | `[measured]` live lease → `converged=false`, `digest=''`; lease released but tree still moving → `converged=false`, `digest=''`, refusal names both sample digests; stopped writer → `converged=true`, `digest == digestInputs(definition)`. Invariant `digest!=='' ⇒ converged===true` holds on all three paths | **PASS** |
| **VER-07** | a verification failure does not permanently drain the run | `node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run src/verification-gates.test.ts --maxWorkers=1 --no-file-parallelism` | `[measured]` **51 passed / 51**, `TEST_EXIT=0`, 105.62 s. The case drives the REAL `SubagentRuntime`: a correction child is admitted **while paused**, and the permanent drain afterwards **rejects** with `/draining; the operation was not admitted/` | **PASS** |
| **VER-08** | an acceptance definition cannot authorize itself | `--print-digest` as a separate step, then re-run | `[measured]` the digest is printed and **nothing is written back**; the weakened definition carrying the old digest is refused at the gate; the honest one runs. `--print-digest` and a run are separate invocations; no flag both authorizes and runs | **PASS** |
| **VER-09** | tier named from the legend, no tier inflated, **and** the record states that no privilege separation exists | `python qualification/results/V9-verification/ver09-tier-audit.py`; `node qualification/runners/acceptance.mjs …/defs/def-ver09-account.json` | `[measured]` 109/109 cases name a legend tier; 0 T5 cases PASS while `live_provider_budget_authorized=false`; 0 old ids overlap this spec. Child account `hzq00` == host account `hzq00` (different pid), so **no privilege separation**, stated in the deployment's own `trust_model_statement` | **PASS** |

**Every case is PASS, and no case was weakened, skipped or re-scoped to get there.**
Two of the nine (VER-01, VER-02) additionally carry the control arm the spec's failure case
implies; VER-03/VER-04/VER-08 carry the control the M8 slice recorded as missing from an
earlier version; VER-05 carries the in-place control that makes the snapshot load-bearing.

---

## 2. What each case was mapped to, and where the gaps were

The brief's instruction was: map the existing evidence onto VER-01..VER-09, fill gaps, file
it. What already existed and what this slice produced:

| case | already measured | produced by this slice |
|---|---|---|
| VER-01 | M8 `cli-transcript.txt` §1, in-suite case | a re-run **under this identity**, with the receipt's own fields printed |
| VER-02 | M8 `cli-transcript.txt` §2, in-suite case | a re-run under this identity |
| VER-03 | M8 §3, T5's VER-09 diagnosis, in-suite closure cases | a re-run, **plus the corrected control arm** (see §3) |
| VER-04 | M8 §4, in-suite independence cases | the **CLI** freshness arm end to end, including the "fresh but not PASS" control |
| VER-05 | M8 two-arm proof, in-suite case | the **printed numbers**: identical endpoint digests, exit 9 in the control arm, the serialized-receipt asymmetry |
| VER-06 | M8 `convergeBeforeFreeze`, in-suite case | the three paths printed with their distinct refusal reasons and the structural invariant |
| VER-07 | M8 §"VER-08 recover after failure", in-suite case | re-run under this identity (51/51) |
| VER-08 | M8 §3, in-suite digest case | the **separation of steps** shown as two commands, plus the control |
| VER-09 | **nothing that establishes this oracle** | a tier audit over the spec + a same-account probe from inside the verification child |

**VER-09 was the real gap.** Every other case had a measured mechanism; VER-09's oracle is
about the RECORD rather than the product, and nothing read the record back. Two instruments
close it: `ver09-tier-audit.py` (mechanical, over the spec and the old gate index) and
`cli-ver09-account.txt` (the same-account measurement, taken from inside the child).

---

## 3. Fixture errors and defects found *in this slice's own work*

Recorded because the project's standard is that a verification authority which hides its own
mistakes is not one, and because two of them are instances of the exact defect class the VER
family exists to catch.

1. **A control arm that failed for the reason it was controlling for.** `[measured]` The
   first VER-03/VER-08 control changed the definition's `id` while keeping the authorized
   digest, and was refused — **correctly**, because `acceptanceDefinitionDigest` hashes the
   whole definition minus `authorizedDigest`. The control was rebuilt with the definition
   byte-identical except for `authorizedDigest`. The broken attempt and its diagnosis are
   preserved in `cli-ver03.txt` rather than deleted.

2. **A probe that died before running a line, for a reason that was not the product's.**
   `[measured]` `ver05-06-aba-and-inflight.mjs` first imported `@deepseek-ai/cordis` itself
   from under `qualification/results/`, where no `node_modules` link exists, and exited
   `ERR_MODULE_NOT_FOUND`. This is the same shape as the two retractions in `docs/GAPS.md`
   ("before filing a defect, confirm the failing path is the one the PRODUCT takes"): the
   failure was in the probe's import list. Fixed by importing only the modules under test,
   by absolute file URL.

3. **An empty negative that would have read as a pass.** `[measured]` The VER-09 clause-2
   cross-check found **zero** explicit tier tokens beside case ids in the sibling gate
   tables. That is not "the other families are tier-honest" — it means the tier is carried by
   the spec case alone there, leaving clause 2 with nothing to contradict. It is recorded as
   the empty result it is, with the reason it is empty, rather than folded into a green.

---

## 4. The findings this slice carries forward from earlier work

These decide several oracles, and they are restated here so a reader of this file does not
have to reconstruct them from four other directories.

- **VER-09's test-file fixture was broken; the product was correct.** `[measured]` on the
  built artifact, `candidate:{cwd:root, baseRevision:base, headRevision:base}` with no
  receipt produces `decision:'refuse'` with `patchBytes:0` — an empty diff, and
  `git apply --check` on an empty patch exits **128** — so it refused for two reasons
  unrelated to the ref. Rebuilt with a real worktree, a real commit and a real vitest
  receipt so `accept_for_publication` is **earned**. Source:
  `packages/dsh-daily-work/src/verification-gates.test.ts`, T5's `FINDINGS.md` §1.3.
- **A sibling case had a weaker oracle and was also repaired.** `[measured]` `ver09c`
  ("an unreadable ref is a refusal") used the identical refusing fixture, so its
  `accepted:false` was true **whether or not the unreadable-ref branch ran at all**. It now
  supplies the assessment as a literal `accept_for_publication` with no reasons, so the
  refusal is attributable. This is the defect class the whole project hunts, found inside
  the file that certifies it.
- **The naming case: the SOURCE was wrong, not the test.** `[measured]` the test requires the
  literal `NOT a security boundary`; the file carried the claim wrapped as markdown bold
  across a line break, which `toContain` cannot see through. The source was fixed and the
  phrase kept contiguous **on purpose**, with a note saying so.
- **FS-06b's refusal was a MISSING RECEIPT, not a product bug.** `[measured]` it now measures
  both the residual gap and its closure.
- **The receipt-binding machinery.** `bindReceipt(recorded, observed)` compares
  `candidateTreeDigest`, `acceptanceDefinitionDigest`, `oracleDigest` and `environment`;
  `observedBasis()` is the observation half, kept as a function so a caller cannot pass the
  record in as the observation. `AcceptanceReceipt` and `VerdictBinding` carry **different
  field sets** — a test that passed a receipt where a binding was expected was one of the
  typecheck errors repaired at the start of this round.
- **A real defect in the data plane, which may bear on what a receipt is allowed to claim.**
  `[measured]` `captureFile` records `requestedRange` in `coverage` but never narrows the
  read, and the acquired-vs-persisted shortfall guard is **DISABLED** when `requestedRange`
  is present. That is a claim-discipline failure — a record asserting a scope it did not
  apply. T8's DATA-12/DATA-13 FAILs; `qualification/results/T8-data/GATES.md` §3a.
  **Not folded into any VER verdict here**: no VER oracle is about `requestedRange`, and
  claiming otherwise would be the same defect one level up.

---

## 5. Build identity for every measurement

`[measured]` The subject modules on the CLI path are read from **SOURCE**:
`qualification/runners/acceptance.mjs` imports
`packages/dsh-daily-work/src/verify.ts` by file URL, so no stale `lib/` is on that path.
The probe `ver05-06-aba-and-inflight.mjs` does the same for `verify.ts` and
`worktree-isolation.ts`.

`[measured]` The package's `lib/` was rebuilt at `2026-09-20 07:37:31`, **newer** than every
non-test `src/*.ts` in the package (newest: `no-sandbox-contract.ts` at `07:29:17`,
`writers-plugin.ts` at `07:21:08`). The vitest run resolves the same way, so both halves of
this slice ran against the same revision.

`[measured]` `git log c3b9dba..HEAD -- packages/dsh-daily-work` is **empty**: no file in the
package under test changed during this slice. The only change on the CLI runner path was
`qualification/runners/verify-spec.py`, which the spec verifier uses and the acceptance
runner does not import.

---

## 6. Raw captures in this directory

| file | contents |
|---|---|
| `verification-gates-tests.raw.txt` | real vitest output, `src/verification-gates.test.ts`, **51 passed / 51**, `TEST_EXIT=0` |
| `cli-ver01-ver02.txt` | the two runner invocations with real exit codes and the receipts they wrote |
| `cli-ver03.txt` | VER-03/VER-08: `--print-digest`, the weakened run, the first (broken) control and its diagnosis |
| `cli-ver03-control.txt` | the corrected control arm, with both digests printed side by side |
| `cli-ver04-freshness.txt` | VER-04: fresh → changed → refused, plus the "fresh but not PASS" control |
| `cli-ver09-account.txt` | VER-09: the same-account measurement from inside the verification child |
| `ver05-06-aba-and-inflight.txt` | VER-05 and VER-06: the printed numbers for both oracles |
| `ver09-tier-audit.txt` / `.json` | the tier audit, text and machine-readable |
| `ver09-sibling-tier-crosscheck.txt` | the clause-2 cross-check against the other families' tables |
| `identity-at-measurement.txt` | the identity this slice measured under, and the drift found while filing |
| `receipt-*.json` | the real receipts the runner wrote |
| `defs/def-*.json` | the definitions the runner was driven with |
| `fixture/`, `fixture-fresh/`, `fixture-account/` | the three tiny fixtures (zero-test, all-skipped, one passing test, an account probe) |
| `VER-01…VER-09-*.txt` | the per-case evidence files, one per spec case |
| `ver05-06-aba-and-inflight.mjs`, `ver09-tier-audit.py` | the two probes this slice wrote |
| `build-evidence.py`, `build-evidence2.py` | the assemblers that generated the per-case files from the raw captures |

---

## 7. What this slice does NOT establish

Stated plainly, because a verification authority that overstates its coverage is worse than
one with a smaller claim.

1. **No live model is involved anywhere in this slice.** Every case drives the runner, the
   service or git directly. The mechanics are honest; that a model would be *stopped* by them
   is untested and not claimed. `live_provider_budget_authorized` is `false`.
2. **VER-03's oracle-digest closure is a MECHANISM, not an enforced policy.** `oracleDigest`
   + `bindReceipt` detect a rewritten oracle; that any production caller passes the right
   `oracleFiles` set is not proven. A caller naming the wrong files, or none, gets no
   protection.
3. **VER-06 measures the freeze DECISION, not its invocation.** That a production caller
   calls `convergeBeforeFreeze` before every acceptance is the caller's to provide.
4. **VER-07 is asserted for the pause/drain distinction, not a whole recovery.** It does not
   run a full failed → corrected → re-verified → completed turn.
5. **VER-09's audit is mechanical.** It checks that a tier is named and that no verdict's
   tier contradicts its status. It cannot check that every tier was honestly CHOSEN — that is
   a reading, and a script claiming to decide it would be a second oracle.
6. **The `all_skipped`/`zero_tests` detection depends on the runner printing a summary.** Two
   grammars are implemented; a third-party runner with a different format reads as
   `runner_never_ran`, which is non-PASS, so the failure mode is safe but would need a parser.
7. **The identity drift in §0 is unresolved.** This slice's evidence names
   `0a0996f3…`, which the lock still records; the spec file on disk no longer hashes to the
   pinned input. Whether that is resolved by re-deriving the identity, by moving the results
   out of the spec, or by serialising the filing is an owner-level decision.
