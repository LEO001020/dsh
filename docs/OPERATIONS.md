# OPERATIONS — install, run, stop, recover, upgrade, roll back

> **Status: only the commands marked VERIFIED have been run on this machine.**
> Everything else is a plan. The evidence for each verified command is under
> `qualification/results/`.

## Paths in use

| Role | Path |
|---|---|
| DSH source checkout (pinned, disposable) | `D:\DSH\src\dsh-src` |
| This implementation repo | `D:\DSH\work\dsh-native-daily` |
| Pinned pnpm shim (see the trap below) | `D:\DSH\tools\bin\pnpm` |
| Canary `DSH_HOME` (C0/C2 experiments) | `D:\DSH\home\canary` … `canary8` (plus `m914`, used by the M9.14 profile-config runs) |
| Daily `DSH_HOME` (production) | not created — nothing is promoted yet. `D:\DSH\home\daily` does **not** exist; verified. |
| Task workspaces | `D:\DSH\work\<task>` |

**The install procedure lives in `docs/DELIVERY.md` §2** and covers the profile
install, the `link:` dependencies and the `agent-presets` root. It is not repeated
here because two copies of an install procedure drift apart, which is exactly how
this project has been bitten before (G-FIX-04, G-FIX-05, G-FIX-12).

## Known blocker: managed child work cannot be started

> **MEASURED 2026-09-20. Read this before following the run instructions below.**

The composed `daily` profile mounts the work service and the model-facing `work`
tool, and **nothing in the product creates a run**. `WorkService.createRun` has
exactly one non-test caller in the repository — `durability-runner.ts:63`, a
hand-run CLI that is itself in no production import graph. So the `work` tool
resolves the run first and throws:

```
this session has no active run; a run is created by user authorization
```

Measured on a real boot of the composed profile, with a positive control that
proves the traversal and the service both work when `createRun` is called
directly: `qualification/results/ROOT-verification/work-tool.json`.

**What this does and does not affect.** The capacity machinery is real and the
hard cap is measured binding in production — T10 recorded a genuine creation
call being refused at 30, with the refusal naming the deployment constant
(`qualification/results/T10-capacity/prod-capacity-report.json`). The launch
port is correctly installed by `createRun` (`2d4534f`), and
`production-port.test.ts` proves it by installing nothing. What is missing is
the **entry point**: no user action reaches `createRun`, so the N=10 rolling
top-up that the delivery plan makes mandatory cannot be exercised on the
composed profile. Recorded as G-SEAM-31 and as a caveat on gate `C01`.

This is stated here rather than only in `GAPS.md` because an operator following
this manual would otherwise hit it as an unexplained error.

## Pinned identity

```
upstream  deepseek-ai/deepseek-harness
commit    ddefc45fbc7f8e46dd73185e68295696d1297887
tag       dsh-v0.1.6-alpha.2
version   0.1.6-alpha.2
pnpm      11.7.0   (via corepack)
node      ^22.19.0 || >=24.0.0   (this machine: v24.18.0)
artifact  apps/cli/lib/bin.js  sha256 69c49c871735dc7ee81ec51f266bbec129f075fd5066e046374f4b13ab02a705
```

Two launchers, two identities, **not interchangeable**:

- built: `node apps/cli/lib/bin.js` — **this is the qualified one.**
- source: `pnpm dsh` = `node --import tsx/esm apps/cli/src/bin.ts`

VERIFIED: with an overlay that inserts a plugin by path, the built launcher
completes the tool round trip while the source launcher dies with
`Cannot read properties of undefined (reading 'prepare')`. Reproduced 3/3.
Evidence: `qualification/results/M0.6-launcher-identity/`.

## Install (VERIFIED)

```sh
cd /d/DSH/src/dsh-src
corepack prepare pnpm@11.7.0 --activate
corepack pnpm install --frozen-lockfile --network-concurrency 4 \
  --fetch-retries 5 --fetch-retry-maxtimeout 120000
```

**TRAP 1 — the network.** The first attempt failed with `TypeError: fetch failed`
after 1285 of 1319 packages. Registry throughput here is 2–35 KiB/s. Reducing
network concurrency and raising the retry budget succeeded in 19m13s. This is a
slow-network problem, not a resolution problem; do not "fix" it by relaxing the
lockfile.

## Build (VERIFIED)

```sh
export PATH="/d/DSH/tools/bin:$PATH"   # the pinned pnpm shim
cd /d/DSH/src/dsh-src
pnpm build
```

**TRAP 2 — the nested pnpm.** The build script spawns a bare `pnpm` from PATH.
That resolved to the GLOBAL pnpm 11.24.0, which refused because the repo declares
`packageManager: pnpm@11.7.0`. Corepack does not switch versions once invoked, so
the nested call stayed on 11.24.0 and the build failed with
`This project is configured to use 11.7.0 of pnpm`.

The fix is a shim directory prepended to PATH (`D:\DSH\tools\bin\pnpm` and
`pnpm.cmd`) that execs the corepack-pinned 11.7.0 directly. **The global pnpm was
not modified or upgraded.** Build then exits 0.

## Start (VERIFIED for headless)

```sh
export PATH="/d/DSH/tools/bin:$PATH"
export DSH_HOME='D:\DSH\home\canary'
cd /d/DSH/src/dsh-src
node apps/cli/lib/bin.js --profile headless --patch <overlay.patch.yml> "task text"
```

VERIFIED: a keyless overlay driven by the in-tree mock adapter produces
`CLI tool round trip complete: CLI_TOOL_ROUND_TRIP` on stdout, reasoning on
stderr, and a persisted zstd JSONL Session with no torn tail.

A daily driver is intended to be a long-lived Web host, because headless exits
after one task and must not be wrapped in a shell loop to fake a second model
loop. **That host has not been qualified on this machine** (gate A12 is
`NOT_RUN`).

## Inspect the resolved configuration (VERIFIED)

```sh
node apps/cli/lib/bin.js --profile <name> --dump-default-config   # bundles only
node apps/cli/lib/bin.js --profile <name> --dump-config           # + profile + home + patches
```

`--dump-default-config` deliberately omits the profile's own patch layer, which is
why it is the right tool for measuring the STOCK baseline. Use `--dump-config` to
see your own patch take effect.

**TRAP 3 — a malformed patch is rejected, not ignored.** A stray literal `[]`
after comment blocks produced
`failed to parse overlay ...: YAMLException: end of the stream or a document
separator is expected`. The loader fails loudly, which is the behaviour you want.

**TRAP 4 — a patch replaces the whole `config` object.** It is not a deep merge.
Restate every key you need, or the others silently revert to schema defaults.

## Run this package's tests

```sh
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
powershell -NoProfile -ExecutionPolicy Bypass -File link-all-dsh.ps1
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
vitest run
```

## Typecheck — the ONE official command

```sh
cd /d/DSH/work/dsh-native-daily
pnpm typecheck
```

**`pnpm typecheck` is the authoritative compiler gate for this repository. Cite
it, and only it, as the typecheck.** It covers BOTH packages (`dsh-daily-work`,
`dsh-ipython`) with their test files included, and it verifies that coverage
rather than assuming it: before checking each package it resolves the config with
`--showConfig` and refuses to report success if the resolved program contains no
`*.test.ts` file. It exits 0 only if every package passes.

`link-all-dsh.ps1` junctions the pinned DSH packages into the extension's
`node_modules` so it compiles against REAL DSH type declarations, deriving the
junction set from the checkout rather than maintaining it by hand. It is a
development convenience for this machine's layout, not part of the deliverable.

**Test count: 1084 collected across 47 files** (`vitest list` at commit `a1d6e6d`).
That is a **collection** count, not a passing count — no full-suite pass/fail run
is recorded in this repository. Earlier revisions of this file said "126 tests, 9
files" (M2 era) and then "592 across 37 files" (`2d4534f`); both were accurate for
their tree and both had gone stale.

**Do NOT cite `tsc -p tsconfig.json --noEmit` as the typecheck.** `tsconfig.json`
excludes `src/**/*.test.ts` (correct for the build, so test code never emits into
`lib/`), which means it exits 0 **with or without** a test file present — a false
pass. This is measured, not asserted: `ID-05`'s control arm injected one type
error into a test file, `tsc -p tsconfig.json` exited **0** and missed it, while
`pnpm typecheck` exited **1** and named the file
(`qualification/results/R2-F10F11/mutation-test.txt`).

**The two configs are not meant to mean the same thing, and that is deliberate.**
`tsconfig.json` is the BUILD face (test code must never emit into `lib/`);
`tsconfig.check.json` extends it, keeps identical strict flags, clears only the
exclude, and adds `noEmit` — it is the CHECK face. There is no root
`tsconfig.json`, and none is wanted: a solution-style root that merely referenced
both packages would add a config without adding coverage. `pnpm typecheck` is the
single entry point instead, and it is what makes "one authoritative gate" true
without collapsing the two compiler faces into one.

Per-package configs, for reference — these are the pieces the official command
drives, not alternatives to it:

| Config | Role |
|---|---|
| `packages/<pkg>/tsconfig.json` | the BUILD: `include src/**/*.ts`, `exclude src/**/*.test.ts` |
| `packages/<pkg>/tsconfig.check.json` | the CHECK: extends the above, clears only the exclude, `noEmit: true` |
| `packages/dsh-daily-work/tsconfig.eco.json` | a SCOPED probe for one case's two files; not a gate |

Switching the gate to the check config immediately surfaced two real type errors
the build config was hiding (recorded in
`qualification/results/M9.2-terminal-advanced/FINDINGS.md`).

## The qualification source plane (F11 / ID-06)

```sh
cd /d/DSH/work/dsh-native-daily
node qualification/runners/check-source-plane.mjs     # exit 0 clean, 1 dirty, 2 unusable
```

**A developer workspace may be dirty; the qualification source plane may not.**
This is a PRECONDITION for starting a qualification run, not a statement about the
artifact. It answers one question: is the checkout we are about to qualify against
the pinned checkout, with nothing tracked-modified, nothing staged, and no
generated state written into it?

**It is deliberately NOT part of the deployment identity.** The identity is the
built launcher digest + lockfile + profile/preset digests + the resolved graph,
and `python helpers/doctor.py` re-derives and verifies it — that is the check that
survives a dirty checkout. Neither check substitutes for the other, and the
distinguishable exit codes keep them apart: this script exits 1 for "the plane is
dirty" and 2 for "the rig is unusable", so a broken invocation can never be read
as a verdict about the source.

To make a boot refuse to launch on a dirty plane, set
`DSH_REQUIRE_CLEAN_SOURCE_PLANE=1` (the shared boot harness honours it). It is
opt-in because exploratory probes deliberately run against mid-edit trees; a run
that wants its result to be citable sets the variable, and a run that does not
cannot cite its result as a qualification verdict.

**The three kinds of entry are classified, not collapsed into "dirty".** A
`CONTENT_MODIFICATION` is a real edit. A `STAGED_CHANGE` is a write to the index.
An `UNTRACKED_GENERATED` path is generated state (a DSH_HOME, an artifact store,
qualification output) that belongs outside the checkout. An `EOL_STAT_DIRTY` entry
is a line-ending artifact: `git status` reports the file modified, but its FILTERED
BLOB ID equals `HEAD`'s, so there is no content delta — the script prints both blob
ids as the proof. It still blocks, because the oracle's machine-checkable
definition of clean is an empty `git status --porcelain` and a gate that quietly
redefined that would be a weaker oracle than the one that was filed.

**The remedy for an EOL entry is named and never run by the gate.** It is
`git add --renormalize <path>`, which rewrites the shared index of a tree this
gate does not own. This project has already paid for five git accidents in a
shared worktree (G-SEAM-35, G-SEAM-42), so the script tells the operator what to
run and refuses to run it. Never `git checkout`/`reset`/`clean` a checkout you do
not own to make a gate green.

## Durability runner (VERIFIED)

```sh
node --import tsx src/durability-runner.ts parent <storeDir> <reportPath>
```

Forks a real Node process, has it admit work into a real storage domain, kills it
with SIGKILL, then reopens the same directory from a fresh process. VERIFIED PASS
on 4 consecutive runs with `childExitSignal: SIGKILL` and all six checks true.

## Stop

Stop means: refuse new admissions, then stop owned work, then release storage,
then unwind the context. **This order was measured, and the naive order deadlocks**
— a child parked in a model call cannot be torn down while context disposal waits
for its driver to exit. See `docs/RECOVERY.md`.

A user Stop outranks top-up. Nothing in this project revives a stopped run.

## Diagnose

```sh
python helpers/doctor.py --source /d/DSH/src/dsh-src
python qualification/runners/build-gates.py
```

The doctor is a read-only metadata check, not a DSH qualification. The gate
generator refuses to emit a PASS with no evidence file on disk.

## Upgrade

1. Diff API, exports and tests between the pinned commit and the candidate.
2. Test in an **independent canary home** using a state copy.
3. Cold backup, or the official consistency export. Never copy a live DB and call
   it a consistent snapshot.
4. Immutable version directory, new process. HMR is not a restart qualification.

Any change to the artifact, lockfile, profile patch, preset, resolved graph or
acceptance spec **changes the deployment identity**, which invalidates every PASS
recorded against the old one. That is the intended behaviour.

## Roll back

**A concrete, checkable sequence is in `docs/DELIVERY.md` §12** — restore the old
artifact **and** the old state snapshot the new version has not migrated, verify
by **tree digest** rather than by presence, and reconcile external effects the new
version already produced **before** the rewind (rolling back software does not
withdraw a remote action). A schema that cannot be migrated safely refuses to
start rather than silently reading a backup.

**Honesty marker:** the rollback has been **rehearsed, not exercised.** No real
newer version has ever been rolled back, because no version has ever been promoted
— the daily home does not exist. The rehearsal is
`qualification/results/R4-upgrade/u06-rollback-rerun.json` (12/12 steps PASS) over
a temp home, with a fixture standing in for the newer version and a counting
in-process fake for the remote. Its own `notClaimed` array says so, and the shell
sequence in DELIVERY §12 has **not** been run end to end by anyone.

## Evidence layout

```
qualification/results/<slice>/
  <slice>-notes.md / FINDINGS.md   what was measured, and what was not
  tests.txt                        real runner output
  tsc.txt                          real type-check output
  source-digests.txt               sha256 of the sources that produced the result
  report*.json                     machine-checkable results where applicable
```

Sensitive full logs stay in a protected location; the redacted summaries are what
gets shared.
