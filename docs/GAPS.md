# GAPS — what is missing, unverified, or externally blocked

Status values: `OPEN` / `IN_PROGRESS` / `RESOLVED` / `BLOCKED_EXTERNAL` / `NOT_APPLICABLE`.
An entry only moves to `RESOLVED` with a link to evidence under `qualification/results/`.

## Environment

| ID | Gap | Status | Note |
|---|---|---|---|
| G-ENV-01 | DSH was not installed on this machine. `D:\DSH` existed but was empty. | RESOLVED | Source cloned to `D:\DSH\src\dsh-src` at the pinned commit. |
| G-ENV-02 | Delivery package recorded Node v22.16.0 which does not satisfy `^22.19.0 \|\| >=24.0.0`. | RESOLVED | This machine has Node v24.18.0, which satisfies `>=24.0.0`. |
| G-ENV-03 | Delivery package recorded the clone blocked by DNS. | RESOLVED | Clone succeeded; `git ls-remote` resolved and the pinned commit fetched. |
| G-ENV-04 | `pnpm install --frozen-lockfile` failed on the first attempt with a network `fetch failed` after 1285/1319 packages. | IN_PROGRESS | Retry with reduced network concurrency and higher retry budget. Registry throughput here is ~2–35 KiB/s, so this is a slow-network issue, not a resolution error. |
| G-ENV-05 | Global `pnpm` is 11.24.0 but the repo pins `pnpm@11.7.0`. | RESOLVED | Corepack activates the pinned 11.7.0; the global pnpm is not used for this repo and is not upgraded. |

## Source-level findings that change the plan

| ID | Gap | Status | Note |
|---|---|---|---|
| G-SEAM-01 | Delivery plan text names `SubagentStartSpec` and `ContinuableSpec`. | RESOLVED | Neither exists. Real names are `SubagentStartRequest` and `ContinuableStartSpec`. Recorded in `docs/DSH_SEAMS.md`. |
| G-SEAM-02 | `ctx.codeRuntime` / `code-runtime` in the attachment. | RESOLVED | Does not exist at this commit; the service is `ctx.ptcRuntime`. |
| G-SEAM-03 | No `status()`/`query()` on `ctx.subagents`. | OPEN | Status must be derived from `listChildren`/`listDescendants` plus lifecycle events. This is the basis of the precise-counting requirement (INV-C1). |
| G-SEAM-04 | `subagent/end` carries no `error` or `diagnostic` field. | OPEN | A teardown failure is visible only as `stopReason: 'error'` (and, per `lifecycle.ts:192-194`, output is withheld). Distinguishing "clean end" from "quarantined unknown" therefore needs more than the event — this is exactly gate C08. |
| G-SEAM-05 | No subagent mock provider exists in `packages/test-support/`. | OPEN | M3 test infrastructure must register its own `SubagentProvider` via the public `registerProvider` seam. The in-tree `continuation-internals.ts` fixture casts to internals and is **not** usable. |
| G-SEAM-06 | `AgentOptions` has no `cwd`. | OPEN | Confirms the delivery plan. Any isolated-workspace writer (conditional slice W) must go through provider/AgentFactory metadata, not through `agentOptions`. |
| G-SEAM-07 | `maxActiveSubagents` default is 8 and rejects `0`. | OPEN | N=10 needs an explicit config override. This is the concrete C0 capability gap. |

## Not yet investigated

| ID | Gap | Status |
|---|---|---|
| G-TODO-01 | Terminal (`ctx.terminals`) exact signatures and Windows shell backends. | IN_PROGRESS |
| G-TODO-02 | `ctx.terminalController` privilege claim — needs a source quote. | IN_PROGRESS |
| G-TODO-03 | PTC runtime public interface and backend publication status. | IN_PROGRESS |
| G-TODO-04 | storageDomain interface, purity of `update`, single-writer enforcement. | IN_PROGRESS |
| G-TODO-05 | Goal `disarm` vs `pause`/`complete` exact semantics. | IN_PROGRESS |
| G-TODO-06 | Profile/preset loading, composition order, patch `config` replacement. | IN_PROGRESS |
| G-TODO-07 | Tool authoring protocol, `guard`, waterfall vs serial events. | IN_PROGRESS |
| G-TODO-08 | Sandbox availability on Windows. | IN_PROGRESS |
| G-TODO-09 | Whether the zloop web-search dual-lane layer can be ported as a DSH plugin. | OPEN |

## External blocks

| ID | Block | Status | What is still doable without it |
|---|---|---|---|
| G-EXT-01 | No confirmed live-provider budget authorization. | BLOCKED_EXTERNAL | Everything except T5/T6: source work, mock-provider stress, real DSH host runs with a controlled route, crash/durability tests, sandbox tests, terminal qualification. The lock records `live_provider_budget_authorized: false`. |
| G-EXT-02 | A model API key being present does not authorize large paid evaluation. | BLOCKED_EXTERNAL | Gate C01's live N=10 run and U04's paired comparison stay blocked until the user authorizes a budget. |
