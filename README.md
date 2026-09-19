# dsh-native-daily

A DSH-native personal daily system for coding and research, built on
DeepSeek Harness. **Status: NOT READY FOR DAILY USE.** See the honest summary at
the bottom before using anything here.

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
| `docs/DSH_SEAMS.md` | Every DSH interface used, with file:line, read at the pinned commit |
| `docs/INVARIANTS.md` | 40 invariants, each bound to the gate that must fail if broken |
| `docs/SECURITY.md` | Trust boundaries and what is enforced where |
| `docs/RECOVERY.md` | Crash behaviour and the measured shutdown order |
| `docs/OPERATIONS.md` | Install, run, stop, upgrade, roll back |
| `docs/GAPS.md` | Everything missing, unverified or externally blocked |
| `docs/exec-plans/0001-master.md` | The living plan and status log |
| `compatibility.lock.json` | The pinned artifact and environment identity |
| `qualification/gates.json` | All 104 gates with status and evidence |
| `qualification/results/` | One directory per slice, with real output |
| `profiles/` | C0 (stock) and C2 (daily candidate) profile templates |
| `packages/dsh-daily-work/` | The one extension package |

## The extension package

`packages/dsh-daily-work` exports four mount points with different lifetimes:

- `dsh-daily-work/host` — the host service. Mounted ONCE by the host profile.
  Owns the run record, the credit reservation and the admission state machine.
- `dsh-daily-work/tools` — the agent-scoped `work` tool. Mounted in the agent
  preset. Holds no cross-session state.
- `dsh-daily-work/service` — the service class, for tests and embedders.
- `dsh-daily-work/web-search` — the ported search provider, registered through
  `ctx.web.registerSearchProvider` so `web_search` routes to it unchanged.

## Quick start

```sh
# 1. The pinned DSH checkout must exist and be built.
#    See docs/OPERATIONS.md for the exact commands and the two traps in them.

# 2. Run this package's tests (T0/T1/T2/T3, no live provider needed).
cd packages/dsh-daily-work
cmd /c link-dsh.cmd          # Windows: junction the pinned DSH packages
vitest run                   # 126 tests

# 3. Regenerate the gate report from evidence.
cd ../..
python qualification/runners/build-gates.py

# 4. Validate it with the delivery package's own checker.
python <delivery>/helpers/check_plan.py \
  --gates qualification/gates.json \
  --spec qualification/specs/gate-spec.json \
  --lock compatibility.lock.json \
  --evidence-root . --target daily
```

## What is actually proven

**83 of 104 gates PASS, 2 are honest FAILs**, with the delivery package's checker
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
- **The extension is loaded by the real profile resolver**, and the `work` tool
  reaches the model: a real Session on the composed `daily-standard` preset
  reports 27 tools including `work`.
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

## What is NOT proven, and must not be implied

Read `docs/GAPS.md` for the full list. The ones that matter most:

- **No live paid N=10 run.** Gate C01 is `BLOCKED_EXTERNAL`:
  `live_provider_budget_authorized` is false in the lock. A key being present
  would not authorize large paid evaluation.
- **Two gates FAIL, measured rather than hidden.** `E01` (credential isolation):
  a confined child READ a canary secret outside the workspace root verbatim,
  exit 0, under both `read-only` and `workspace-write` — the boundary is a WRITE
  boundary, and the seam has no read lever even in principle. `E06` (network
  egress): a confined child completed a real HTTP round trip under both modes;
  `web_fetch`'s SSRF guard filters that tool's URL only and is bypassed by any
  shell command. Both were previously `NOT_RUN`; measuring them moved them to
  `FAIL`, which understates less.
- **Terminal framing is forgeable, and the cost is quantified.** A send result
  carries an identical field list for success and failure with **no verdict
  field**, so failure is visible only as text. A forged OSC `133;D;0` marker
  settles the send in **138–185 ms** versus **3025–3135 ms** for the same command
  answered honestly, while the cell is still sleeping. Framing is a convenience,
  not an integrity mechanism.
- **The record's `epoch` field is inert.** `record.ts` documents it as the
  reject-on-stale point, but nothing reads or writes it after
  `initialRunRecord` sets it to 1. Object identity covers an in-process resume; a
  run re-adopted across a **process** boundary has no enforcement today.
- **A preset is not self-contained, and two presets sharing one composition file
  share one ESM module instance.** Registrations are per-Session and the tool
  catalogs stay separate, but module-scope state does not. That is why
  `src/tools.ts` holds no cross-session state — a measured constraint, not a
  style preference.
- **A second host silently destroys the first host's committed work.** Measured:
  a real second process opens the same live store with no error, its write lands
  durably, and then the first host's next publish erases it. Nothing upstream
  refuses. The deployment boundary is the only protection unless `homeLockPath`
  is configured, and it is **not** configured by default.
- **`ctx.terminals.spawn()` does not resolve under `read-only` sandbox mode on
  Windows.** It resolves under `workspace-write` (~0.8–1.2 s) and
  `danger-full-access` (~740 ms). An earlier version of this README said
  "confined" generally; that was a measurement error from probing a single mode.
- **A caller-supplied `maxDepth` lifts the deployment depth cap.** It is an
  absolute cap, not a ceiling, so a larger value admits deeper delegation. This
  project's own path is unaffected — it passes deployment config and never the
  model's value — but any direct caller can widen it.
- **No real coding or research task has been run** under a frozen configuration,
  so there is no end-to-end quality claim.
- **The remaining `NOT_RUN` gates are the honest headline.** Run
  `python qualification/runners/build-gates.py` for the current count; it is
  derived from evidence on disk and refuses to invent a PASS.

## Promotion decision

`NOT_READY`. Mandatory gates remain `NOT_RUN` or `BLOCKED_EXTERNAL`. Nothing in
this repository is certified for daily use, and the gate report says so in its
own vocabulary rather than in a footnote.
