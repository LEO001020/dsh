# AGENTS.md — navigation for agents working in this repo

This repo implements a **DSH-native personal daily system**: a coding + research
harness built on DeepSeek Harness, not a port of any prior orchestration project.

Read the documents you need for the slice you are doing. Do not re-read everything.

## Start here

| Need | Read |
|---|---|
| What to build, what is forbidden, when it is "done" | `docs/exec-plans/0001-master.md` (distilled from the delivery plan) |
| Exact DSH API shapes verified on this machine | `docs/DSH_SEAMS.md` |
| Non-negotiable system invariants | `docs/INVARIANTS.md` |
| Security boundary | `docs/SECURITY.md` |
| Crash / restart behaviour | `docs/RECOVERY.md` |
| Run, stop, diagnose, upgrade | `docs/OPERATIONS.md` |
| What is missing / blocked | `docs/GAPS.md` |
| Why a decision was made | `docs/decisions/` |
| Evidence ledger (sources read) | `research/sources.jsonl` |

## Hard constraints (never break these)

1. **Zero legacy production code reuse.** No scheduler, state machine, DAG, role
   graph, event bus, SessionLease, SQLite history, receipt DB, MCP sidecar, model
   router, or generic memory from any prior orchestra project. Only failure
   descriptions may migrate, and only as `invariant → regression case`.
2. **N=10 rolling top-up is mandatory**, not optional/lab. Root is **not** one of
   the ten. Root keeps its own reserved inference budget. Idle sessions never
   count as assignments.
3. **No invented APIs.** Every DSH call must resolve to a real export at the
   pinned commit. No `as any`, no editing third-party `.d.ts`, no deep import
   from `/src/`, no `Symbol.for` private ABI.
4. **No second model loop.** The existing AgentLoop samples the model. Our code
   produces events and resource constraints only.
5. **`ctx.terminals` for model Python. Never `ctx.terminalController`.** The
   latter is the human Web terminal running with system-user privilege.
6. **Unknown effects are never auto-replayed.** Reconciliation before retry.
7. **No PASS by weakening.** Do not edit oracles, skip tests, lower N, widen
   permissions, or report success without a real runner's evidence.
   `NOT_RUN`, `FAIL`, `BLOCKED_EXTERNAL` are not PASS.

## Layout

```
compatibility.lock.json     pinned artifact + environment identity
profiles/                   profile/preset TEMPLATES (runtime dirs live elsewhere)
  stock-canary/             C0: exact shipped profile + preset
  daily-candidate/          C1/C2: + repo instructions + work extension
qualification/
  specs/                    frozen acceptance definitions (protected)
  runners/                  executable gate runners
  fixtures/                 test fixtures
  results/                  per-case evidence, one directory per case
packages/dsh-daily-work/    the ONE extension package (host service + tools)
docs/                       seams, invariants, security, recovery, operations, gaps
research/                   read-only source ledger
```

## Commands

See `docs/OPERATIONS.md`. Nothing here is verified until it is run on this
machine and the output is stored under `qualification/results/`.

## Working discipline for each slice

read the relevant seam + tests → write a failing contract/integration case →
implement the minimum → run type/test/fault-injection → inspect diff and
permissions → store evidence → commit a revertible commit → update the ExecPlan.

This is the *engineering* process. It is not a Planner/Executor/Reviewer loop
injected into the daily root.
