# GAPS — what is missing, unverified, or externally blocked

Status values: `OPEN` / `IN_PROGRESS` / `RESOLVED` / `BLOCKED_EXTERNAL` / `NOT_APPLICABLE`.
An entry only moves to `RESOLVED` with a link to evidence under `qualification/results/`.

## Environment

| ID | Gap | Status | Note |
|---|---|---|---|
| G-ENV-01 | DSH was not installed on this machine. `D:\DSH` existed but was empty. | RESOLVED | Source cloned to `D:\DSH\src\dsh-src` at the pinned commit; built artifact at `apps/cli/lib/bin.js`. |
| G-ENV-02 | Delivery package recorded Node v22.16.0 which does not satisfy `^22.19.0 \|\| >=24.0.0`. | RESOLVED | This machine has Node v24.18.0, which satisfies `>=24.0.0`. |
| G-ENV-03 | Delivery package recorded the clone blocked by DNS. | RESOLVED | Clone succeeded; `git ls-remote` resolved and the pinned commit fetched. |
| G-ENV-04 | `pnpm install --frozen-lockfile` failed on the first attempt with a network `fetch failed` after 1285/1319 packages. | RESOLVED | Retried with `--network-concurrency 4 --fetch-retries 5`; succeeded in 19m13s, exit 0. Registry throughput here is ~2–35 KiB/s, so this was a slow-network issue, not a resolution error. |
| G-ENV-05 | Global `pnpm` is 11.24.0 but the repo pins `pnpm@11.7.0`. | RESOLVED | Corepack activates 11.7.0. The BUILD script spawns bare `pnpm` from PATH, which resolved to the global 11.24.0 and failed; fixed with a PATH shim to the pinned pnpm. The global pnpm was not modified. |
| G-ENV-06 | The built launcher and the source launcher are different distribution identities. | OPEN — finding | Reproduced 3/3. See `qualification/results/M0.6-launcher-identity/`. The built artifact is the qualified one; the source launcher is a development convenience and is not a drop-in substitute. |

## Source-level findings that change the plan

| ID | Gap | Status | Note |
|---|---|---|---|
| G-SEAM-01 | Delivery plan text names `SubagentStartSpec` and `ContinuableSpec`. | RESOLVED | Neither exists. Real names are `SubagentStartRequest` and `ContinuableStartSpec`. Recorded in `docs/DSH_SEAMS.md`. |
| G-SEAM-02 | `ctx.codeRuntime` / `code-runtime` in the attachment. | RESOLVED | Does not exist at this commit; the service is `ctx.ptcRuntime`. |
| G-SEAM-03 | No `status()`/`query()` on `ctx.subagents`. | OPEN | Status must be derived from `listChildren`/`listDescendants` plus lifecycle events. This is the basis of the precise-counting requirement (INV-C1). |
| G-SEAM-04 | `subagent/end` carries no `error` or `diagnostic` field. | OPEN | A teardown failure is visible only as `stopReason: 'error'` (and per `lifecycle.ts:192-194`, output is withheld). Distinguishing a clean end from a quarantined unknown therefore needs more than the event — this is gate C08. |
| G-SEAM-05 | No subagent mock provider exists in `packages/test-support/`. | OPEN | M3 test infrastructure must register its own `SubagentProvider` via the public `registerProvider` seam. The in-tree `continuation-internals.ts` fixture casts to internals and is NOT usable. |
| G-SEAM-06 | `AgentOptions` has no `cwd`. | OPEN | Confirms the delivery plan. Any isolated-workspace writer (conditional slice W) must go through provider/AgentFactory metadata. Additionally, `childSessionMeta` copies the PARENT's `header.cwd`, so the spawn-in-process provider cannot give a child an isolated workspace at all. |
| G-SEAM-07 | `maxActiveSubagents` default is 8 and rejects `0`. | **CONFIRMED BY MEASUREMENT** | `--dump-default-config` for headless/web/sdk all show `id: subagent` with NO config block. N=10 is not satisfiable by any shipped profile; an explicit override is required. Evidence: `qualification/results/M0.5-c0-resolved-graph/`. |
| G-SEAM-08 | `agent/idle` does not exist; `agent.dispose()` does not exist. | RESOLVED | Idle is `agent/status` with `status: 'idle'`. Teardown is `AgentHandle.dispose()`. |
| G-SEAM-09 | `storageDomain` has no `spec` member; `get`/`put`/`update` are `KvTable` methods. | RESOLVED | The spec is the argument to `open()`. Recorded in `docs/DSH_SEAMS.md`. |
| G-SEAM-10 | No host lease and no cross-process write locking anywhere in storage. | OPEN — design constraint | Documented upstream as a limitation. This is why the second host must be blocked at the deployment boundary (INV-D7, gate D02) rather than by an upstream lease. |
| G-SEAM-11 | `dsh-tool-terminal` (the `terminal_*` tools) is mounted by NO shipped preset or bundle. | OPEN — M6 risk | The shipped presets mount `dsh-tool-bash-persistent`/`-pwsh-persistent` instead. Gate T01 must verify the actual resolved profile before any IPython qualification. |
| G-SEAM-12 | Windows sandbox is real but write-only and `enforcement: 'partial'`. | OPEN — security constraint | Reads, network and process visibility are unconfined. Network egress is uncontrolled for bash/pwsh/subprocess/PTC; only `web_fetch` has SSRF filtering. This bounds what gates E01/E02/E06 can honestly claim. |
| G-SEAM-13 | **`ctx.terminals.spawn()` does not resolve under a confined sandbox mode on Windows.** | OPEN — M6 limitation | Measured: read-only/workspace-write hang forever; `danger-full-access` resolves in ~740ms. The Windows ACL runner wraps the shell and the backend's prompt/idle handshake does not complete through it. Every layer beneath was proven independently. So cross-call persistent computation is qualified only UNCONFINED. Evidence: `qualification/results/M6.1-terminal-qualification/M6-FINDINGS.md`. |
| G-SEAM-14 | The terminal service rejects a forged owner object. | RESOLVED — property | `ensureOwnerCleanup` compares the registry entry by identity (`ctx.get('agents')?.get(owner.id) === owner`), so only a real Agent can own a PTY. Found by failing tests, not by reading. |
| G-SEAM-15 | The `tool-plugin-manager` row is `disabled: true` in the shipped standard preset. | RESOLVED — property | And when enabled it demands `danger-full-access`, warning that installation can execute build scripts. This project does not enable it. |
| G-SEAM-16 | The **standard** preset mounts no PTY at all; the **minimal** preset does. | OPEN — affects M6 | `standard/agent.cordis.yml` has no terminal rows. `minimal/agent.cordis.yml` mounts `@deepseek-ai/dsh-terminal` plus `terminal-bash` (pwsh dialect on Windows, `timeoutMs: 300000`). A daily profile that wants native persistence must therefore adopt the minimal preset's terminal block or a preset derived from it. |
| G-SEAM-17 | `dsh-tool-terminal` (the six `terminal_*` tools) is mounted by NO shipped preset. | OPEN | The shipped presets mount the `*-persistent` shell tools instead. The `terminal_*` tools appear only in a snapshot composition. So the model's route to a PTY on a shipped profile is `tool-bash-persistent` / `tool-pwsh-persistent`, not `tool-terminal`. |

## Fixed during implementation

| ID | Defect | Status | Note |
|---|---|---|---|
| G-FIX-01 | Counting computed occupancy with a second formula that could disagree with the state machine. | RESOLVED | Caught by test. Occupancy now derives from the single `holdsSlot` predicate. |
| G-FIX-02 | `mayAdmit` and the reported `budget_blocked` reason used different budget predicates. | RESOLVED | Caught by test. Both now share `budgetExhausted`, so a reported block cannot disagree with the admission gate. |
| G-FIX-03 | The host plugin used a synchronous `apply` that started the domain open inside `ctx.effect`, so `await ctx.plugin(...)` returned before the domain was open. | RESOLVED | Caught by test. Now an `async apply` that awaits the open, matching the shape `dsh-storage-domain` itself uses. |

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
