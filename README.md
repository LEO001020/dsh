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

- **The new architecture is partly built, and the part that is missing is the
  larger part.** An IPython kernel now exists and reaches the model:
  `packages/dsh-ipython/` is a real bundle with `package.json` +
  `dsh.bundle.patch`, a `cordis.patch.yml` mounting the kernel service at host
  level, a compiled `lib/`, an agent-preset row shipping ONE `ipython` tool with
  ONE `code` parameter, and a passing test suite. A fresh install following
  `docs/DELIVERY.md` §2, booted from a foreign cwd with a probe that adds **no**
  row, reports **28 agent-keyed tools** with `ipython` and `work` present and
  `error: null` (`qualification/results/R9-delivery/surface-r9-verified-fresh-install.json`).
  **This paragraph replaces an earlier one that said the package had no
  `package.json`, no `lib/`, no bundle patch and no test — that was true when it
  was written and is false now.** What is still missing is everything else the new
  target requires: there is **no `python_exec` tool name**, the shell has **not**
  left the daily preset (`pwsh` is still in the catalog beside `ipython`), there is
  no N control in a UI, and there is no hard host-wide 30. The `M11-ipython/` and
  `M5-lifecycle/` probes remain kernel-mechanics probes with the stated scope "no
  DSH, no native tools, no LLM" — they are not evidence for any new gate — and
  **all 112 new cases are `NOT_RUN`** (verified: every one of the 112 entries in
  `qualification/specs/acceptance-spec.json` carries `"status": "NOT_RUN"`).
- **The model's execution surface is `pwsh` AND `ipython`, not `python_exec`.**
  An earlier version of this README said the catalog was 27 tools including `pwsh`
  and no `python_exec`, and repeated it twice. The 27 is a stale measurement: it
  came from `M8.5-c2-real-boot/e2e-tool.json`, taken **before** the `ipython` tool
  row shipped. The current measured catalog is **28 tools including `pwsh` and
  `ipython`, still with no tool named `python_exec`**. The run to cite is
  `R9-delivery/surface-r9-verified-fresh-install.json` — a fresh install following
  `docs/DELIVERY.md` §2, booted from a foreign cwd, with the probe adding no row and
  its `presetRoots` confirming the home that was booted. Two earlier 28-tool runs
  exist (`M12-deliverable-surface/surface.json`, `M11-ipython/e2e-tool.json`) and
  neither is as strong: the first was contaminated by a shared output path
  (G-FIX-13) and the second got its row from a verification overlay that INSERTED
  it. The architecture's requirement is that the shell *leave* the daily preset; it
  has not, so this remains unproven — but the reason is now "the shell is still
  there", not "there is no kernel".
- **The production launch port was missing until `2d4534f`.** At the snapshot where
  this audit started, `WorkService.setLaunchPort` had **zero production callers**:
  `host-plugin.ts` constructed the service, opened the domain and never installed a
  port, so on the composed profile a model `submit` recorded a task, transitioned
  it to `unknown` with the reason `no launch port installed`, and launched nothing.
  The N=10 suite could not see this, because it installs its own port — a port seam
  exists precisely so the top-up logic can be driven by a scripted adapter, so
  every one of those tests passed while the product could not launch a single
  child. `createRun` now calls `installDefaultLaunchPort(root)`, the bundle patch
  names `subagentProvider: spawn`, and `production-port.test.ts` (`b8f1ef2`)
  installs **nothing** and asserts the drain reaches the real `startContinuable`
  seam. **This is established at the test tier, not the boot tier**: the N=10
  evidence predates the change and no gate report has been regenerated. See
  `docs/DELETE-AUDIT.md` §3.2.2.
- **The Goal handover was also missing its production caller, and is now wired.**
  `takeContinuation` — the `goals.disarm` handover that makes managed work the
  single continuation owner — had zero production callers; only `goal.test.ts` and
  `isolation.test.ts` called it. Those tests passed because they call it
  **directly**, so they proved the mechanism while the product still had two
  continuation owners armed on one root. `982e82b` takes it at `createRun` and
  **stores** the result on the run record (new optional `continuation` field), so a
  run whose handover never happened is distinguishable from one recorded as "no
  goal present". **Established at the code and test tier, not the boot tier** — no
  gate has been regenerated. One gap remains and is named in the audit: nothing
  *reads* `.continuation` yet, so the field records the handover rather than
  checking it. See `docs/DELETE-AUDIT.md` §3.2.1 and §2.5.
- **Two more mechanisms are proven but not called by the product, and one of them
  is still open.** `docs/DELETE-AUDIT.md` §3.8 records the class: three mechanisms
  were implemented, well-tested, and unreachable from any production path. Two are
  now wired (the launch port, the Goal handover). The third is the run `epoch`
  guard in `recovery.ts` — **still open**, so the `epoch` field is inert in the
  product. See the epoch entry below.
- **No live paid N=10 run.** Gate C01 is `BLOCKED_EXTERNAL`:
  `live_provider_budget_authorized` is false in the lock. A key being present
  would not authorize large paid evaluation.
- **Two gates FAIL, measured rather than hidden.** `E01` (credential isolation):
  a confined child READ a canary secret outside the workspace root verbatim,
  exit 0, under both `read-only` and `workspace-write` — **the boundary is a WRITE
  boundary, not a read or egress boundary**, and the seam has no read lever even
  in principle. `E06` (network egress): a confined child completed a real HTTP
  round trip under both modes; `web_fetch`'s SSRF guard filters that tool's URL
  only and is bypassed by any shell command. Both were previously `NOT_RUN`;
  measuring them moved them to `FAIL`, which understates less.
- **Terminal framing is forgeable, and the cost is quantified.** A send result
  carries an identical field list for success and failure with **no verdict
  field**, so failure is visible only as text. A forged OSC `133;D;0` marker
  settles the send in **138–185 ms** versus **3025–3135 ms** for the same command
  answered honestly, while the cell is still sleeping. Framing is a convenience,
  not an integrity mechanism.
- **Signal-based interruption silently does nothing under confinement.** Under
  `workspace-write`, `terminals.signal(..., 'SIGINT')` returns `{delivered: true}`
  in ~17 ms and the command **runs to completion** (5/5 trials; a 20 s sleep
  printed its token at 20.1 s). `SIGTERM` behaves the same. The mechanism is a
  `\x03` input write reaching the ACL runner's console rather than powershell's
  foreground process. `terminals.kill()` does stop it — at the cost of the session
  state the persistent PTY existed to provide.
- **The record's `epoch` field is inert in the product.** `record.ts` documents it
  as *"bumped when a run is re-adopted by a new host generation. A callback
  carrying a stale epoch must be rejected rather than silently accepted."* The
  guard that would do that is real and tested (`applyWorkerSettlement` in
  `recovery.ts` compares the settlement's epoch to the record's and refuses the
  write), **but `recovery.ts` is not reachable from any production path**: it has
  zero non-test importers, is outside the closure of every `package.json` export,
  and `applyWorkerSettlement` has zero callers outside its own module and its test.
  Nothing else reads or writes `epoch` after `initialRunRecord` sets it to 1, so
  nothing bumps it either. What *is* enforced is object identity
  (`tool-protocol-guards.ts` compares the calling Agent against the live registry),
  which covers the in-process resume case; a run re-adopted across a **process**
  boundary has no enforcement today. `tool-protocol-guards.ts:61-67` says exactly
  this and was right all along. See `docs/DELETE-AUDIT.md` §3.8.1.
- **A preset is not self-contained, and two presets sharing one composition file
  share one ESM module instance.** Registrations are per-Session and the tool
  catalogs stay separate, but module-scope state does not. That is why
  `src/tools.ts` holds no cross-session state — a measured constraint, not a
  style preference.
- **A second host silently destroys the first host's committed work unless
  `homeLockPath` is configured — and no shipped profile sets it.** Measured: a
  real second process opens the same live store with no error, its write lands
  durably, and then the first host's next publish erases it. The kernel-held lock
  that fixes this (`src/homelock.ts`) is real and proven *when configured*; the
  default has no cross-process protection.
- **`ctx.terminals.spawn()` does not resolve under `read-only` sandbox mode on
  Windows.** It resolves under `workspace-write` (~0.8–1.2 s) and
  `danger-full-access` (~740 ms). An earlier version of this README said
  "confined" generally; that was a measurement error from probing a single mode.
- **A caller-supplied `maxDepth` lifts the deployment depth cap.** It is an
  absolute cap, not a ceiling, so a larger value admits deeper delegation, and an
  **omitted** value behaves the same as `99`. This project's own path is
  unaffected — it passes deployment config and never the model's value — but the
  workflow/PTC path calls `subagents.start()` with no `maxDepth` at all.
- **No real coding or research task has been run** under a frozen configuration,
  so there is no end-to-end quality claim.
- **The old gate report's evidence is now fully consistent — an earlier claim here
  was wrong.** This README previously said "124 match, 3 do not", naming T05, T06
  and T08 as citing `M9.2-terminal-advanced/FINDINGS.md` at `1f1408e7…` against a
  file that had moved to `615adaad…`. **Re-hashing all 127 evidence references in
  `qualification/gates.json` against disk gives 127 match, 0 missing, 0 stale.**
  T05/T06/T08 record `615adaad87d29e3c…`, which is the file's current digest; the
  `1f1408e7…` value was the older one and the rows had already been regenerated
  before the claim was written. The correction is recorded as G-VER-05 in
  `docs/GAPS.md` rather than quietly dropped, because an unverified negative claim
  is worth as little as an unverified positive one.
- **The remaining `NOT_RUN` gates are the honest headline.** Run
  `python qualification/runners/build-gates.py` for the current count; it is
  derived from evidence on disk and refuses to invent a PASS.

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
