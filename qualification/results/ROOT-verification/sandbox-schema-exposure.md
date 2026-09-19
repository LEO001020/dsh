# The model-visible tool schema exposes sandbox escalation fields — and the
# mechanism is `sandboxMode !== undefined`, not the mode's value

**Measured, not inferred.** A real profile boot, reading the tool catalog the
model actually receives. Baseline before the M1 composition changes landed.

## What the model sees

28 tools. Three of them advertise escalation parameters:

```
pwsh  -> ["sandbox_permissions", "justification"]
write -> ["sandbox_permissions", "justification"]
edit  -> ["sandbox_permissions", "justification"]
```

`run_code` is **not in the catalog at all** — so Node PTC is not currently
model-facing in this deployment.

## Why, in source

The advertisement is gated on whether the mounted backend CONFINES, which is a
different question from what mode it is in:

```ts
// packages/fs/fs/src/index.ts:93-104
 * `undefined` when it does not confine at all -- the capability fact the tool
 * layer reads to advertise the escalation fields honestly (mirrors
 * `ShellExecutor.sandboxMode`). The base class and the bare local backend
 * report `undefined`; a sandboxing backend (`@deepseek-ai/dsh-fs-sandbox`)
 * overrides it with the deployment default.
get sandboxMode(): SandboxMode | undefined { return undefined }
```

```ts
// packages/fs/tool-fs/src/sandbox.ts:45-48
this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
```

```ts
// packages/fs/tool-fs/src/index.ts:74-76
// One escalation API shared by both mutating tools: advertisement gating,
// per-call policy resolution, and denial-marker mapping, all keyed off whether
// the mounted ctx.fs confines (ctx.fs.sandboxMode).
```

So `sandbox_permissions` appears on `write`/`edit` whenever `fs-sandbox` is the
mounted provider — **even under `danger-full-access`**, because the getter
returns the deployment default (a defined value) rather than reflecting whether
the fence does anything.

The same shape holds for PTC: `packages/core/tools/src/ptc.ts:115-118` gates on
`runtime.sandboxMode === undefined`, so a mounted Node PTC runtime advertises
the fields regardless of the mode.

## Two consequences

**1. This is the defect GPT Pro warned about.** A model at `danger-full-access`
can mechanically fill in `sandbox_permissions` and trigger an
"already at maximum authority but still requesting escalation" invalid
failure / retry loop. The schema does not disappear merely because the
deployment is unconfined.

**2. The fix is provider replacement, not mode configuration.**
- Swapping `fs-sandbox` -> `fs-local` removes the fields from `write`/`edit`,
  because the base class returns `undefined`. **This happens as a consequence of
  the swap; no separate change is needed.**
- Turning model-facing `pwsh` off removes them from `pwsh`.
- Removing Node PTC would remove them from `run_code` (latent here, since
  `run_code` is not in the catalog).

**So the correct final assertion is "zero tools with escalation fields", and it
is a JOINT result of three changes.** An agent reporting any single one of those
changes should not claim it alone.

## The tool list at this baseline

```
ask_user_question, create_goal, edit, exit_plan_mode, get_goal, glob, grep,
interrupt_agent, ipython, job_kill, job_list, job_output, list_agents, present,
pwsh, read, read_image, send_message, skill, subagent, subagent_fork,
todo_write, update_goal, web_fetch, web_search, work, workflow, write
```

Evidence: `qualification/results/ROOT-verification/tool-schema.json`, produced
by `.probe/tool-schema-probe.mjs` through
`qualification/runners/boot-harness.mjs`.
