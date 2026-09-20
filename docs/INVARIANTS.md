# INVARIANTS — the things that must stay true

Each invariant has an ID, a statement, and the gate that must fail if it is
broken. Gates are the acceptance IDs from the delivery `ACCEPTANCE.zh-CN.md`.
An invariant with no failing gate is a wish, not an invariant.

## Concurrency (M3)

| ID | Invariant | Gate |
|---|---|---|
| INV-C1 | `active + launching + stopping + quarantined_unknown` never exceeds the configured target N. | C07, C08 |
| INV-C2 | Root is not counted in N; root retains reserved inference credit. | C01, C05 |
| INV-C3 | One child completion releases exactly one slot and starts exactly one replacement; no duplicate launch, no missed top-up. | C02, C03 |
| INV-C4 | A slot is not released while the child may still be running (cancel sent but not confirmed, disposal error, unknown). | C07, C08 |
| INV-C5 | Deficit is reported honestly (`capacity_deficit` + reason). N is never silently lowered to 8. | C04, C09 |
| INV-C6 | A child that starts real model/tool work and still holds an open assignment counts as in-flight. An idle session with no task does not. | C01, C16 |
| INV-C7 | Every path that can create extra work (native spawn, fork, workflow/PTC subagent, external CLI, recursive children) is either metered or denied. A missing `tool_filter` never means "already restricted". | C12, C13 |

## Lifecycle and ownership (M2/M4)

| ID | Invariant | Gate |
|---|---|---|
| INV-L1 | Every listener, timer, guard and tool registration is owned by a Cordis effect/fiber and is disposed with it. | B03 |
| INV-L2 | load → unload → load does not double-register, leak a timer, or message a different Session. | B03 |
| INV-L3 | Authority is bound to the exact live Agent object, not to a session-id string. A stale callback cannot write authoritative state. **Scope of the claim, stated because it was once wider**: the enforcement is object identity alone (`tool-protocol-guards.ts` compares the registry entry by OBJECT, `ctx.agents.get(id) === owner`), which covers an in-process resume — a case the product can reach. A run re-adopted across a **process** boundary is NOT covered and v2 does not claim it. This invariant previously read "…plus run epoch"; that half named a field and a guard that were **deleted rather than wired** (F8 / REC-09 / REC-10 — see `qualification/results/R9-recovery-topology/`), because no production path can construct a settlement from a superseded generation. | B04, D10 |
| INV-L4 | The plugin never awaits the same Agent's `whenIdle`/`dispose` from inside its own `agent/created` or `agent/turn-stopping` hook. | B03, F06 |
| INV-L5 | `tools/pre-execute` waterfalls call `next`; `agent/turn-stopping` is serial and has no `next`. | B07 |
| INV-L6 | `ctx.tools.guard()` stays synchronous and is the final deny. It never awaits a database or an approval. | B07 |

## Admission and durability (M4)

| ID | Invariant | Gate |
|---|---|---|
| INV-D1 | A task is never admitted without its credit reservation; they are written in one atomic `update` transform. No cross-key "transaction" is claimed. | D01 |
| INV-D2 | `get` results are treated as immutable; `update` callbacks are pure synchronous transforms with no I/O inside. | D01 |
| INV-D3 | Five distinct positions are tracked separately: intent admitted / child Session-Inbox accepted / Inbox claimed / entered a real model request / effect confirmed. | D03, D04, D05, D06, D07 |
| INV-D4 | `DUPLICATE_CHILD` triggers reconciliation of the existing child, never a retry with a fresh UUID. | D04 |
| INV-D5 | Unknown usage/effect stays conservatively reserved. It is never assumed free and never auto-replayed. | D07, D09, E10, E11 |
| INV-D6 | Reopening a Session does not re-authorize unbounded background execution; a persisted per-run resume authorization with TTL is required, otherwise recovery is paused. | D13 |
| INV-D7 | One host service opens a domain once; consumers share the handle. The domain is not treated as a cross-process CAS. | D02, D11 |

## Security (M5)

| ID | Invariant | Gate |
|---|---|---|
| INV-S1 | Model Python uses `ctx.terminals` (owner + agent sandbox). `ctx.terminalController` is never wrapped as a model tool. | E02, T02 |
| INV-S2 | Loopback binding is not treated as identity isolation; a reproducible test shows the model cannot reach the control plane. | E02 |
| INV-S3 | Home directory, credentials, plugin code, state DB, acceptance definitions and other Sessions are not readable/writable by the task sandbox. | E01, E05 |
| INV-S4 | Model tool permission, OS permission, Web/API control-plane permission and provider credential permission are modelled separately. | E01, E02, E06 |
| INV-S5 | Instructions found in retrieved content are data, not permission. | E04 |
| INV-S6 | Verification runs untrusted repo code in isolation; the verifier cannot be used to obtain host credentials or control-plane access. | E12 |
| INV-S7 | Cancelling an external effect is not reported as undoing it. | E11 |

## Verification (M5/M8)

| ID | Invariant | Gate |
|---|---|---|
| INV-V1 | A completion claim is never the oracle. Only a real runner's result is. | F01 |
| INV-V2 | No command, all-skipped, runner-never-ran, timeout and unknown are all non-PASS. | F02 |
| INV-V3 | A receipt binds candidate tree digest, acceptance-definition digest, environment identity, command, exit/signal, coverage and bounded output. | F03 |
| INV-V4 | Only before/after hashes are not enough to exclude ABA; verification uses an immutable input snapshot. | F04 |
| INV-V5 | Acceptance thresholds and oracles are protected from the model being verified. | F05 |
| INV-V6 | Integration accepts a candidate only with an exact base patch and expected-ref CAS. | F08 |

## Goal ownership (M3)

| ID | Invariant | Gate |
|---|---|---|
| INV-G1 | In managed-work mode there is exactly one continuation owner for a root. | C14 |
| INV-G2 | `disarm` removes process-local continuation only; the durable objective is not cleared and completion is not faked. | C14 |
| INV-G3 | Children and model tools cannot re-arm Goal inside a managed run; the guard is scoped to that run and does not affect other Sessions. | C14 |
| INV-G4 | A user Stop or pause outranks top-up. No dispose callback, late result or Goal auto-round revives a stopped run. | C06 |

## Terminal (M6)

| ID | Invariant | Gate |
|---|---|---|
| INV-T1 | `terminal_send` returning `stdin_read` / `inferred_idle` / `timeout` / `session_exit` is never recorded as cell success. | T04 |
| INV-T2 | A background `pty-send` Job "completed" is a wait ending, not a cell completing. | T04 |
| INV-T3 | No next cell is sent into a PTY whose previous cell outcome is unknown. | T04 |
| INV-T4 | `terminal_read` is a bounded scrollback view, not a complete log cursor. Large output goes to an artifact. | T07 |
| INV-T5 | Marker/prompt framing is not treated as tamper-proof verification. | T08 |
| INV-T6 | After a host restart, in-memory terminal state loss is reported honestly; historical cells are not auto-replayed. | T06 |

## Research and accounting (M7)

| ID | Invariant | Gate |
|---|---|---|
| INV-R1 | A failed provider is `unavailable`, never "no results exist". | R01 |
| INV-R2 | Evidence state distinguishes discovered / bytes_captured / parsed / presented / cited / checked. There is no automatic `understood`. | R02, R03 |
| INV-R3 | A request manifest is not inferred from the maximum session seq; compaction removes old results. | R04 |
| INV-R4 | Cost covers root + descendants + retries + compaction/summary/search. Missing usage is `unknown`, not zero. | R06 |
| INV-R5 | Python/history access is scoped to authorized sessions; the whole `DSH_HOME` is not mounted for convenience. | R08 |
