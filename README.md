# dsh-native-daily

A DSH-native personal daily system for coding and research, built on
DeepSeek Harness. **Status: NOT READY FOR DAILY USE.** See the honest summary at
the bottom before using anything here.

> **Target architecture changed on 2026-09-20.** The new contract
> (`DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20`) makes a **persistent
> IPython kernel** the model's primary execution surface, adds a native
> observation/artifact data plane, raises child capacity to a hard 30, and
> requires the model-facing shell to leave the daily preset. **Most of that is now
> built.** Measured on a fresh install booted from a foreign cwd
> (`qualification/results/M12-deliverable-surface/surface-fresh-install.json`):
> the composed profile's catalog holds **27 tools**, `ipython` is present with the
> single parameter `code` and is **the only execution surface** — `pwsh` and
> `bash` are both absent — and `work` is present. The hard capacity of 30 is
> implemented and measured **binding in production**: a genuine `startContinuable`
> call was refused at 30 with the refusal naming the deployment constant
> (`qualification/results/T10-capacity/prod-capacity-report.json`).
>
> **What is NOT done, and it is the load-bearing gap.** Two things the contract
> requires are missing, and they are the same defect in different places: a
> mechanism that works, with nothing in the product that calls it.
> 1. **No user action creates a run** (`G-SEAM-31`). `WorkService.createRun` has
>    no production caller, so the model-facing `work` tool throws `this session has
>    no active run` — which means the mandatory N=10 rolling top-up cannot be
>    exercised on the composed profile. Every N=10 measurement was produced by a
>    test that calls `createRun` directly.
> 2. **The Python cell cannot reach a DSH tool** (`G-SEAM-34`). The native bridge
>    (`bridge.ts`, `native-call.ts`) is outside the transitive closure of every
>    package entry point and `new BridgeServer` has zero production call sites. The
>    FORBIDDEN seam is correctly absent — `ctx.terminalController` appears in no
>    production file — but the sanctioned one is unwired, so today the model's
>    Python has no tool access at all.
>
> Also absent: a tool named `python_exec` (the contract's name; this build calls it
> `ipython`), and an N control in a UI. **The acceptance spec is
> `qualification/specs/acceptance-spec.trusted-local-v1.json` — 109 cases, and all
> 109 are `NOT_RUN`.** The older 104-case report
> (`qualification/gates.json`) shares **zero** case ids with it, so no number in
> that report is progress toward this target. See `docs/DELETE-AUDIT.md` §4.
> Deployment identity is `0a0996f3…`; promotion is `NOT_READY`.

## What this is

An implementation of the mandatory rolling child-work capability on top of DSH's
own machinery, plus the evidence needed to say what works and what does not.

It is **not** a port of any earlier orchestration project. There is exactly one
model loop and it is DSH's. This project adds a resource controller: it decides
whether a child may be admitted, holds a credit reservation, and keeps a
reconciliation relation. It does not decide what work means.

## Layout

| Path | What it is |
|---|---|
| `AGENTS.md` | Navigation for an agent working here, plus the hard constraints |
| `ARCHITECTURE.md` | How the pieces fit and why the record exists at all |
| `docs/DELIVERY.md` | Operations manual: install, doctor, start, pause, recover, shutdown, N, permissions, backup, rollback, gate reading |
| `docs/DELETE-AUDIT.md` | The shrink audit: real import graph, per-module classification, named-candidate verification, old-vs-new inventory |
| `docs/DSH_SEAMS.md` | Every DSH interface used, with file:line, read at the pinned commit |
| `docs/INVARIANTS.md` | 48 invariants, each bound to the gate that must fail if broken |
| `docs/SECURITY.md` | Trust boundaries and what is enforced where |
| `docs/RECOVERY.md` | Crash behaviour and the measured shutdown order |
| `docs/OPERATIONS.md` | Install, run, stop, upgrade, roll back |
| `docs/GAPS.md` | Everything missing, unverified or externally blocked |
| `docs/exec-plans/0001-master.md` | The living plan and status log |
| `compatibility.lock.json` | The pinned artifact and environment identity |
| `qualification/gates.json` | All 104 gates with status and evidence (schema_version 1 — the OLD spec) |
| `qualification/results/` | One directory per slice, with real output |
| `profiles/` | C0 (stock) and C2 (daily candidate) profile templates |
| `packages/dsh-daily-work/` | The rolling child-work extension package (11 exports) |
| `packages/dsh-ipython/` | The persistent-IPython extension package (5 exports) |
| `qualification/results/R9-delivery/` | This delivery pass's claim-check, corrections and verdict basis |

## The extension packages

**Two** packages now ship, and both are loaded as bundles by the composed profile:
`packages/dsh-daily-work` (the rolling child-work controller) and
`packages/dsh-ipython` (the persistent IPython execution surface).

`packages/dsh-daily-work` exports **eleven** entry points. Five carry the
capability this README is about:

- `dsh-daily-work/host` — the host service. Mounted ONCE by the host profile.
  Owns the run record, the credit reservation and the admission state machine.
- `dsh-daily-work/tools` — the agent-scoped `work` tool. Mounted in the agent
  preset. Holds no cross-session state.
- `dsh-daily-work/service` — the service class, for tests and embedders.
- `dsh-daily-work/web-search` — the ported search provider, registered through
  `ctx.web.registerSearchProvider` so `web_search` routes to it unchanged.
- `dsh-daily-work/tool-protocol-guards` — the exact-owner guard for `work`,
  mounted at the host plane so it applies deployment-wide.

The other six are newer and are mounted by the bundle patch: `data-host` and
`data-service` (the observation/artifact plane), `history` (authorized history and
web provenance), `writers` (writer isolation and integration), and
`programmatic-scope` (the extracted nested-dispatch scope). **An earlier version
of this README said "five mount points" and "the one extension package"; both
numbers are now wrong**, and a reader counting exports should run
`python -c "import json;print(len(json.load(open('packages/dsh-daily-work/package.json'))['exports']))"`
rather than trusting prose.

`packages/dsh-ipython` exports `host` (the kernel service), `tool` (the ONE
model-facing `ipython` tool), `kernel`, `plugin` and `protocol`. Its model-facing
surface is deliberately one tool with one `code` parameter — no lifecycle tool
(`ipython_open`/`_send`/`_read`/`_status`/`_close`) is registered anywhere in the
package, and that absence is asserted in a real boot.

**The product path is wider than ten modules now.** `qualification/results/R3-unwired/import-graph.txt`
is the current import graph, re-run at 78 `src/` files / 31 non-test modules: **25
reachable, 6 unreachable**. The unreachable six are `durability-runner.ts`,
`effects.ts`, `kernel-lifecycle.ts`, `perf-metrics.ts`, `reconcile.ts` and
`recovery.ts`. **An earlier version of this README listed `launch-port.ts` and
`recovery.ts` among the test-only modules; `launch-port.ts` is now on the product
path** (it is a non-test importer of `host.ts` and is imported by it), and
`verify.ts` is now reachable through the `writers` export. The older
`docs/DELETE-AUDIT.md` §1 graph is a snapshot at `2d4534f` and says so; prefer
`R3-unwired/import-graph.txt` when the two disagree.

## Quick start

```sh
# 1. The pinned DSH checkout must exist and be built.
#    See docs/DELIVERY.md for the exact commands and the six traps in them.

# 2. Run this package's tests (no live provider needed).
cd packages/dsh-daily-work
powershell -NoProfile -ExecutionPolicy Bypass -File link-all-dsh.ps1
vitest run
tsc -p tsconfig.check.json   # the config that includes test files

# 3. Regenerate the gate report from evidence.
cd ../..
python qualification/runners/build-gates.py
```

**Test count: 1084 collected across 47 files.** Measured with `vitest list` at
commit `a1d6e6d`. That is a **collection** count, not a passing count — no
full-suite pass/fail run is recorded in this repository, and `vitest list` executes
nothing. This replaces an earlier "592 across 37 files" measured at `2d4534f`,
which was accurate for its tree and had gone stale. It is a snapshot of a tree
under active concurrent edit, so read it as "at `a1d6e6d`", not as a standing
claim: a mid-edit tree does not parse, and a collection count can move with no
test added or removed.

`tsc -p tsconfig.json` is **not** the check to cite: it excludes
`src/**/*.test.ts` and therefore exits 0 with or without a test file present.
`tsconfig.check.json` keeps identical strict flags and clears only that exclude.

## What is actually proven

**85 of 104 gates PASS, 2 are honest FAILs**, with the delivery package's checker
reporting **zero structural errors** on the report. Every PASS carries at least
one evidence file whose sha256 is recorded, and the generator refuses to emit a
PASS with no evidence on disk. The load-bearing results:

- **Ten children are admitted through the real `ctx.subagents.startContinuable`
  seam on the production AgentLoop**, with a real Session each, and the ceiling
  is enforced by DSH itself and not only by this project's bookkeeping.
- **One completion admits exactly one replacement**, without waiting for the
  wave. Two concurrent drains on one free slot produce exactly one child.
- **Admission is not execution.** Every task lands in `accepted`, and an
  unobserved child is not counted as an active assignment.
- **A run survives a real SIGKILL.** The record, every task state and the exact
  reservation were recovered from a fresh process, and reconciliation returned
  `unknown` rather than relaunching anything.
- **The extension is loaded by the real profile resolver**, and both tools reach
  the model: a real Session on the composed `daily-standard` preset reports **28**
  tools including `work` **and `ipython`**. The `ipython` count is newer than the
  `work` one — see "What is NOT proven" for why 28 supersedes an earlier 27.
- **Cross-call state persists in a native PTY** under `workspace-write`, so
  persistent computation works without an adapter.
- **The acceptance runner does not trust exit codes.** Two cases with a real
  exit code of 0 — an all-skipped suite and a zero-test run — are still non-PASS.
- **An A→B→A mutation during verification is caught by an immutable snapshot**,
  and the in-place control arm proves endpoint hashing alone would have
  certified the tampered run.
- **The C0 capability gap is measured, not assumed**: every shipped profile
  mounts `@deepseek-ai/dsh-subagent` with no config block, so N is 8. C2's patch
  raises it to 10 and the resolved graph shows it.

### Proven but NOT part of the new target

Ten of those PASSes are the **M6 terminal block (T01–T10)**, whose subject is the
native PTY as the model's execution surface — exactly what the new architecture
removes. They are real measurements of a real mechanism, and they are not
progress toward `python_exec`. Likewise `J01`/`J02`/`J03` were recorded
`NOT_APPLICABLE` on the note "No dedicated kernel is implemented; the native
terminal was qualified instead"; the new architecture makes that kernel
mandatory, so those three become live obligations. `docs/DELETE-AUDIT.md` §4.2
lists every obsolete PASS.

## What is NOT proven, and must not be implied

Read `docs/GAPS.md` for the full list. The ones that matter most:

- **The architecture is built, and the two things still missing are both the same
  defect: a mechanism that works with nothing in the product that calls it.**
  Measured on a fresh install following `docs/DELIVERY.md` §2, booted from a
  foreign cwd, with a probe that adds **no** row
  (`qualification/results/M12-deliverable-surface/surface-fresh-install.json`):
  **27 agent-keyed tools**, `ipython` present with the single parameter `code` and
  it is **the only execution surface** — `pwsh` and `bash` are both absent — and
  `work` is present with `error: null`. The hard capacity of 30 is implemented and
  measured **binding in production**: a genuine `startContinuable` call was refused
  at 30, naming the deployment constant
  (`qualification/results/T10-capacity/prod-capacity-report.json`).

  **What is missing is reach, and it is two cases of one shape:**
  1. **No user action creates a run** (`G-SEAM-31`). `WorkService.createRun` has no
     production caller, so the model-facing `work` tool throws `this session has no
     active run` and the **mandatory** N=10 rolling top-up cannot be exercised on
     the composed profile. Every N=10 measurement came from a test that calls
     `createRun` directly.
  2. **The Python cell cannot reach a DSH tool** (`G-SEAM-34`). The native bridge
     (`bridge.ts`, `native-call.ts`) is outside the transitive closure of every
     package entry point, and `new BridgeServer` has zero production call sites.
     The FORBIDDEN seam is correctly absent — `ctx.terminalController` appears in no
     production file — but the sanctioned one is unwired, so today the model's
     Python has no tool access through either path. Because `ipython` is the only
     execution surface, this is not academic.

  **This paragraph replaces an earlier one that said the shell had not left the
  preset and that the catalog still carried `pwsh` beside `ipython`. That was true
  when written and is false now** — commit `35c829d` disabled the `tool-pwsh` row
  unconditionally. The count moved 27 → 28 → 27 for two different reasons, and
  `docs/DELIVERY.md` §8.2 records the sequence, because a count that moves in both
  directions must never be cited without its composition.
- **The spec is 109 cases, not 112, and its verdicts are filed in place.** The
  authoritative file is `qualification/specs/acceptance-spec.trusted-local-v1.json`
  (`trusted-local-v1`, 109 cases, 11 families). It is a **ledger**: each case
  carries its own `status` and `evidence`, filed as the case is established, so
  read the spec itself rather than any count in prose. The frozen as-authored
  artifact is kept separately at `qualification/specs/frozen/` because the live
  file's digest changes as verdicts are filed — the pin names the authored
  artifact, and `helpers/doctor.py` plus `verify-identity.py` both check that.
  **No PASS is inherited**: the older 104-case report and its 85 PASSes are valid
  evidence for the OLD identity only.
- **The deployment is not confined, and one seam still says otherwise.** The
  execution plane is unconfined — measured: `PwshLocalExecutor`, `LocalFileSystem`,
  the permission plane disabled, approval policy `never`. But
  `sandboxPolicy.defaultMode` is **`workspace-write`**, not `danger-full-access`
  (`G-SEAM-33`), so the model is told a false statement about its own authority and
  the PTC path still confines. The now-mounted `daily-no-sandbox-contract` row
  detects this on every boot: it runs 8 deployment checks and its two failures are
  exactly this and the PTC mode.
- **A page cursor is refused across a different revision but not across a
  different store** (`G-SEAM-41`), and the served bytes can hash differently from
  the descriptor naming them — `pages()` calls `store.openRange` directly and never
  routes through `resolveReference`'s content check.
- **Two of the six observation-gap stages have no producer at all**
  (`G-SEAM-40`), and a transport loss that IS counted in the ipython plane
  (`droppedFrames`) is never wired into `acquisition.gaps` — the two planes do not
  meet.
- **Concurrent `drain` callers over-admit past the target, and `capacityDeficit`
  reads 0** (`G-SEAM-45`), so the overshoot is invisible to the reader that exists
  to catch it. Measured with zero real children.
- **The epoch guard is unreachable** (`G-SEAM-21`), so the run record's `epoch` is
  inert; and the KERNEL epoch, which does advance, is a different field with the
  same name (`G-SEAM-43`).
- **No live paid run.** `live_provider_budget_authorized` is `false`. A key being
  present would not authorize large paid evaluation.

## Promotion decision

`NOT_READY`. Re-read from `qualification/gates.json` rather than copied from an
earlier revision of this file: **104 old-spec cases = PASS 85 · NOT_RUN 10 ·
FAIL 2 · BLOCKED_EXTERNAL 1 · NOT_APPLICABLE 6**, of which the **88 mandatory**
split **75 PASS, 10 `NOT_RUN`, 2 `FAIL`, 1 `BLOCKED_EXTERNAL`**. The 13 non-PASS
mandatory gates are `A12`, `C01`, `E01`, `E02`, `E06`, `E12`, `R01`, `U01`, `U02`,
`U03`, `U04`, `U05`, `U06`, each with its reason in `docs/DELIVERY.md` §9.
Nothing in this repository is certified for daily use, and the gate report says so
in its own vocabulary rather than in a footnote.

The external blocker is named exactly: `compatibility.lock.json` →
`runtime_authorization.live_provider_budget_authorized` is **`false`**. It holds
`C01` at `BLOCKED_EXTERNAL` and blocks the paid halves of the new spec's
`ECO-07`/`ECO-08`/`UPG-07`. The two `FAIL`s are platform facts, not unbuilt work:
the Windows sandbox seam has no read lever (`E01`) and no network vocabulary
(`E06`), so they cannot be closed on this host at all.

The `NOT_READY` above is against the **old** spec. Against the new 112-case spec
the state is simpler and worse: **all 112 cases are `NOT_RUN`** (verified against
`qualification/specs/acceptance-spec.json`, not inherited from an earlier
revision), because the architecture they describe is not built. Note the contrast
that matters: the new spec's `IPY-*` family is `NOT_RUN` even though a real
`ipython` tool now appears in a real Session's catalog. A tool being wired is not
a case passing. See `qualification/results/M10-shrink/FINDINGS.md` for the
promotion decision with per-gate reproduction and repair actions.
