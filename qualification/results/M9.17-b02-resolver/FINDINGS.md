# M9.17 — B02 re-verification against the real profile resolver

**Status: PASS (re-verified). The previous PASS was an over-claim and is retracted.**

## Why this re-verification exists

B02 ("peer single instance — load the plugin from the final profile resolver and
check dependency realpaths") was previously reported PASS on evidence that only
proved `ctx.plugin()` direct mounting inside a vitest process. That is a weaker
claim than the gate asks for, and the gap was not theoretical:

- The package had **never been compiled** (no `lib/`), so there was nothing for a
  resolver to load.
- The package **declared no `dsh.bundle.patch`**, so `dsh plugin add` installed it
  as a plain dependency and activated **no layer at all**. The plugin was never
  loaded by the profile, while the direct-mount test still passed.

Booting the profile produced `dsh: warning: 1 entry did not activate` /
`daily-work-host (dsh-daily-work/host): failed to import`. The direct-mount test
could not see this because it never went through the resolver.

The user's question ("have you finished all of the DSH harness?") is what
surfaced it. The lesson is recorded here rather than smoothed over: a gate whose
oracle is weaker than its scenario will pass while the product is broken.

## What was fixed

1. `packages/dsh-daily-work` compiled: `tsc -p tsconfig.json` → `lib/`.
2. `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
3. `packages/dsh-daily-work/cordis.patch.yml` created with the host row, the
   subagent `maxActiveSubagents: 10` row, and the web-search row.
4. `dsh plugin --profile daily add <path>` now reports `dsh-daily-work` in
   `dsh.profile.bundles`, and the boot warning is **gone**.

## How B02 is now measured

`qualification/runners/verify-b02.mjs` runs **inside a real `dsh --profile daily`
boot** and reports:

| Probe | Result |
|---|---|
| Realpath of every peer the extension depends on | all resolve to exactly ONE path each |
| Source-resolved peers (`.ts`) | **none** — `sourceResolved: []` |
| Built peers (`lib/*.js`) | all 7 |
| Distinct copies found across 3 resolution roots | **1 per peer** |
| Live services: `tools`, `storageDomain`, `agents`, `dailyWork`, `agentPresets`, `web` | all present |

The three resolution roots are the extension under test, the profile that
installed it, and the DSH checkout. Resolving from all three turns "there is no
duplicate Cordis" from an assumption into a measurement.

### Two measurement errors found and corrected during this probe

Both were mine, and both would have produced a false finding:

1. **Wrong resolution root.** `createRequire(import.meta.url)` resolved from the
   runner's own directory, which has no `node_modules`, so every peer reported
   `unresolvable`. The profile's own `node_modules` holds only the linked
   extension — DSH itself is resolved from the source tree. Fixed by resolving
   from the extension's `package.json`.

2. **Wrong `src` detector.** A naive `/\/src\//` path test flagged all seven
   peers as "source copies". The checkout root is literally `D:\DSH\src\dsh-src`,
   so *every* path contains a `src` segment. The honest discriminator is the file
   the resolution landed on (`.ts` vs `lib/*.js`), not a substring.

3. **`inject` is a readiness gate.** The first run omitted `dailyWork` from
   `inject` and therefore ran *before* the service registered, reporting a false
   absence. A row that injects a service runs only after that service is
   provided; the working probe injects `dailyWork`.

## What this proves

- The extension is loaded by the **real profile resolver**, not only by
  `ctx.plugin()`.
- There is exactly **one** copy of Cordis and of each injected DSH service on
  every resolution root; no `src`/`lib` module-identity mix.
- The services the extension injects are the live host singletons.

## What this does NOT prove

- It does not prove the model can reach the `work` tool. That is a separate
  claim, proven in `M8.5-c2-real-boot/e2e-tool.json` (see below).
- It does not exercise a reload of the *deployed* profile by the host's own
  watcher; the lifecycle cycles in M9.18 are driven explicitly.

## Related: the `work` tool now reaches the model

`M8.5-c2-real-boot/e2e-tool.json`, from a real Session on the composed
`daily-standard` preset:

```
toolCountAgentKey: 27    workToolPresent: true
toolCountContextKey: 0
tools: [... "work", "workflow", "write"]
```

`workToolPresent: true` with `work` visible in the full list is the last link in
the "extension actually reaches the model" chain.

The `toolCountContextKey: 0` field is deliberate: it records the exact mistake
that produced an earlier false `toolCount: 0`. The scope key for a tool view is
the **Agent object**, not its context — `AgentLoop` builds the scope with
`createScope(loopCtx, this)` (`packages/core/agent-loop/src/agent.ts:104`) and
DSH's own PTC harvests with `registry.schemas(exec.agent)`
(`packages/core/tools/src/ptc.ts:682`). Passing `agent.ctx` yields a key owning no
scope layer, so the view collapses to the global layer, which holds zero agent
tools. Both numbers are recorded so the contrast is evidence rather than
folklore.
