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
| 2026-09-19 | M0.2 source fetch + install + build at pinned SHA | DONE | `qualification/results/M0.2-source/` |
| 2026-09-19 | M0.4 first real tool chain | DONE | `qualification/results/M0.4-first-toolcall/` |
| 2026-09-19 | M0.5 C0 resolved graph (the capability gap, measured) | DONE | `qualification/results/M0.5-c0-resolved-graph/` |
| 2026-09-19 | M0.6 launcher identity: built vs source (A03) | DONE — finding | `qualification/results/M0.6-launcher-identity/` |
| 2026-09-19 | M2.1 work core: state machine + precise counting | DONE | `qualification/results/M2.1-work-core/` |
| 2026-09-19 | M2.2 work host service vs real storage domain | DONE | `qualification/results/M2.2-work-host/` |
| 2026-09-19 | M2.3 tool consumer + plugin lifecycle | DONE | `qualification/results/M2.3-plugin-lifecycle/` |
| 2026-09-19 | M3.1 launch port + C2 profile (N=10 override) | DONE | `qualification/results/M3.1-c2-profile/` |
| 2026-09-19 | M3.2 N=10 rolling top-up on the production loop | DONE (T1/T2) | `qualification/results/M3.2-N10-concurrency/` |

## Where we actually are

**M0 complete.** Auditable install, real first tool chain, hashed C0 graph.

**M1 complete for C0.** The stock control group is measured and hashed; the
capability gap (maxActiveSubagents=8, no config block) is a recorded fact rather
than an assumption.

**M2 complete.** The extension compiles against real DSH declarations, mounts
through the real Cordis pipeline, registers its tool once, releases its domain
handle on unload, and survives load → unload → load.

**M3 substantially complete at the offline layers.** The mandatory rolling top-up
now runs against the production AgentLoop with the real `startContinuable` seam:
ten children admitted, ceiling enforced by DSH itself, one completion admits one
replacement, the root stays separate, a pause stops admission, and a completion
storm cannot double-admit.

What remains in M3 is exactly one thing, and it is externally blocked:

- the **live paid** N=10 run (gate C01/T5). The lock records
  `live_provider_budget_authorized: false`. A key being present does not
  authorize large paid evaluation, so this stays `BLOCKED_EXTERNAL` until the
  user authorizes a budget.

## Immediate next slice

**M4 — durability and reconciliation.** The five positions (intent admitted /
Inbox accepted / Inbox claimed / entered a request / effect confirmed) are
already modelled as distinct admission states with distinct slot semantics. What
M4 adds is the *recovery procedure*: reopen a run in a NEW process, query each
reserved `childId` against its Session, and resolve `unknown` honestly. The
storage-domain reopen path is already proven by `host.test.ts`; what is missing
is doing it after a real process kill and against real child Sessions.

Gates targeted: D03, D04, D05, D06, D07, D08, D09, D10, D11, D13.

