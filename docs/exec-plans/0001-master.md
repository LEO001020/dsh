# ExecPlan 0001 — DSH Native Daily (master plan)

Status: **IN PROGRESS — M0**
Owner: local implementation agent
Source of requirements: `MASTER_EXECUTION_PROMPT.zh-CN.md` v1.0 (2026-09-19),
`ACCEPTANCE.zh-CN.md`, `DSH_SEAMS.zh-CN.md` (delivery package, kept read-only at
`C:\Users\hzq00\Downloads\DSH_NATIVE_DAILY_EXECUTION_PLAN_2026-09-19\`).

This file is the living plan. It is distilled from the delivery prompt so that
slices can be executed without re-reading the whole prompt. Where this file and
the delivery prompt disagree, the delivery prompt wins and this file is wrong.

## Deliverables

1. A repeatable install / configure / start / diagnose / rollback configuration
   for DSH as a daily driver.
2. Native integration tests bound to the actual chosen host profile, agent
   preset, and provider/model route — not a simulated second agent loop.
3. User-selectable **N in-flight child assignments with rolling top-up**, with a
   real N=10 acceptance run. Root is separate and is not counted in N.
4. Reconciliation between DSH-native Session/Inbox recovery and this project's
   work-admission records. Unknown effects are never blindly replayed.
5. Tools, permissions, evidence and verification configuration good enough for
   real coding and research work.
6. Qualification of cross-call persistent Python/IPython on the **native**
   terminal. Whether a cell adapter or Jupyter provider is needed is decided by
   measured gaps, not by default.
7. Security, failure and real-task gate records, plus an explicit daily
   promotion result.

## Conditional capabilities — do NOT pre-build

Dedicated Jupyter service; multi-worktree writer provider; PTC-first root;
custom context optimizer; semantic causal barrier; generic memory;
self-rewriting harness.

Proving a conditional capability unnecessary **is a success**. Marking the
user-mandated forced concurrency as "optional" **is a failure**.

## Milestones

| M | Goal | Exit condition |
|---|---|---|
| M0 | Bootstrap doctor + version identity | Auditable install artifact + first REAL tool call + state dir, or a specific BLOCKED/FAIL |
| M1 | Real stock control group | Final profile/preset/tool/provider graph, first-request representation, C0 tests and diff records reproducible |
| M2 | Minimal DSH-native plugin | Types, build, single-instance load, real loop call, error propagation, cancel, repeated unload all pass |
| M3 | Mandatory rolling top-up | Real DSH/mock-provider stress + authorized real N=10 check. Queue-limit tests or ten idle processes do not count |
| M4 | Durability, Inbox, recovery | Evidence for real process kill, torn tail, repeated recovery, admitted-but-unacked, before/after claim windows |
| M5 | Permissions, unknown effect, independent verification | Protected verifier, effect-unknown semantics, real sandbox denial, model-to-control-plane isolation |
| M6 | Persistent Python on native terminal | Stock terminal qualification result + explicit decision native / thin adapter / dedicated kernel |
| M7 | Research evidence, history, context, cache | Long-history recovery, original-source support, projection vs archive, real request/attempt correlation, cost gaps visible |
| M8 | Test system, failure handling, promotion | Real coding+research tasks under a frozen configuration, N=10 measured, upgrade and rollback evidence |

## Control groups

- **C0** — exact shipped profile + shipped preset + chosen model, in a fresh
  isolated `DSH_HOME` with no home-patch contamination. Nothing removed and then
  still called stock.
- **C1** — C0 + minimal repo instructions.
- **C2** — C1 + the mandatory work extension (`packages/dsh-daily-work`).

Each additional capability adds exactly one explainable difference.

## Working discipline

Per slice: read the seam + tests → write a failing contract/integration case →
implement the minimum → run type/test/fault injection → inspect diff and
permissions → store evidence → commit → update this ExecPlan.

## Status log

Append one entry per completed slice. Newest last.

| Date | Slice | Result | Evidence |
|---|---|---|---|
| 2026-09-19 | M0.1 environment probe | DONE | `qualification/results/M0.1-environment/` |
| 2026-09-19 | M0.2 source fetch at pinned SHA | DONE | `qualification/results/M0.2-source/` |
