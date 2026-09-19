# T4 — the AGENT PRESET PLANE: model-facing PowerShell off, IPython primary

**Status: the change is IN and MEASURED. Verdict PASS on both phases.**

The one-line result, from a real boot of the composed `daily` profile on the
profile's OWN default preset, from a foreign cwd (`C:/`), on a bound-and-verified
free port:

| | BEFORE | AFTER |
|---|---|---|
| `toolCountAgentKey` | **28** | **27** |
| `pwsh` | present | **absent** |
| `ipython` | present, `["code"]` | present, `["code"]` |
| activation warnings | 0 | 0 |
| live loader audit (175 entries) | 0 inactive | 0 inactive |
| checks | 35/35 PASS | 38/38 PASS |

The catalog delta is exactly `{removed: ["pwsh"], added: []}`.

---

## 1. Why the preset is the file that decides this

The task's premise, and the correction it is built on: **editing
`profiles/daily-candidate/cordis.patch.yml` alone cannot change the model's tool
surface.**

`packages/bundle/web-app/cordis.patch.yml` moved the agent plane behind agent
presets. It sets `disabled: true` on the HOST rows `tool-bash`, `tool-pwsh`,
`tool-fs`, `tool-fs-search`, `tool-jobs`, `tool-skill`, `tool-subagent*`,
`workflow-ptc`, `tool-workflow`, `tool-todo`, `tool-web`, `plan-mode`,
`compaction-*`, `agent-instructions` and `tool-plugin-manager`, and lets each
Session mount a preset that composes them instead.

The mechanism is that `ctx.tools` layers are keyed by the **Agent object**:
`AgentLoop` builds its scope with `createScope(loopCtx, this)`
(`packages/core/agent-loop/src/agent.ts:104`). A tool row mounted at host level
publishes into the root realm, which no agent's scope selects — so the model gets
the service and no way to call it, silently. That is Trap 7 in
`docs/DELIVERY.md`, and the reason `daily-work-tools`/`ipython-tool` live in the
preset.

**This is recorded as two facts from ONE boot, not as an inference.** The
artifact carries `hostRowsOfInterest` (the host plane's own state for those ids)
beside the model's catalog. The host `tool-pwsh` row is `disabled: true`, and the
model still saw `pwsh` in the BEFORE run. Both statements are in the same JSON.

---

## 2. The exact rows changed

One file: `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
(`sha256 16bc20e559d0c05b810876522fd468952b421a69ed2b5276a3ddd06c01053bce`,
from `1e89d675d05a4e2a3bac19d2e8cfff6c2e6561edaa074acf286977a4668c6648`).

Exactly ONE row's behaviour changed:

```yaml
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: true            # was: !!js process.platform !== 'win32'
```

`tool-bash` is left **exactly as shipped** (`!!js process.platform === 'win32'`,
inert on Windows). Changing it would be a POSIX claim with no POSIX evidence
behind it — the "claim you did not measure" failure this repository records as
G-FIX-04. The asymmetry is stated in the file so a reader sees it rather than
inferring it.

Everything else added to the file is **comment only**: a header block on the
agent plane and IPython-as-primary-surface, an expanded shell section, and a
section recording the PTC/`workflow` dependency chain. Verified by
`diff` against the shipped preset: the only non-comment changes are the
`disabled:` line above and the two pre-existing appended rows
(`daily-work-tools`, `ipython-tool`).

Rows deliberately **kept**: `tool-fs`, `tool-fs-search`, `tool-web`, `tool-jobs`,
`tool-skill`, `tool-goal`, `plan-mode`, `compaction`, `delegation` (subagent,
subagent_fork, workflow-ptc, tool-workflow), `tool-ask-user`, `tool-todo`,
`present`, `daily-work-tools`, `ipython-tool`. Every one is asserted row-by-row
in the AFTER artifact, not merely counted.

---

## 3. Why model-facing PowerShell is off — and the explicit NON-claim

The kernel is a real CPython with its own pid, and `import subprocess` reaches
every command PowerShell could run. Keeping both presents the model with **two
action dialects over the same OS authority**: it costs schema tokens in every
request, and it splits behaviour — a task learned through `pwsh` cannot be reused
through `ipython` and vice versa. One programmable surface removes the fork
instead of documenting it.

**THIS IS NOT A SECURITY MEASURE, AND IT IS NOT CONTAINMENT.** Disabling this row
does **not** reduce what the model can reach. The `ipython` kernel runs
unconfined, as the same OS user, with the same file and network access a shell
had (`docs/GAPS.md` G-SEAM-25). It removes a second **interface**, not a
capability. Anyone who later wants containment must build it elsewhere and must
not cite this row as evidence that any exists. This sentence is in the preset
file itself, not only here, so a future reader of the composition cannot miss it.

### Escalation fields: attributed, not claimed

The coordinator measured that three model-visible schemas advertise
`sandbox_permissions` + `justification`. I reproduced that independently in the
BEFORE run and recorded the gate for each:

| tool | advertises escalation fields | which gate | whose change removes it |
|---|---|---|---|
| `pwsh` | yes | `ctx.shell.sandboxMode` (`packages/shell/tool-pwsh/src/index.ts:196`; `pwsh-sandbox` overrides at `packages/shell/pwsh-sandbox/src/index.ts:83`) | **T4 (this task)** — the whole tool leaves the catalog |
| `write` | yes | `ctx.fs.sandboxMode` via `FsSandboxController` (`packages/fs/tool-fs/src/sandbox.ts:45`; base reports `undefined` at `packages/fs/fs/src/index.ts:104`, only a confining backend overrides) | **T2 (fs provider swap `fs-sandbox` → `fs-local`)**, NOT this task |
| `edit` | yes | same as `write` | **T2**, NOT this task |

Measured, both phases:

```
BEFORE: tools advertising escalation fields: ["edit","pwsh","write"]
        shell.sandboxMode: "workspace-write"   fs.sandboxMode: "workspace-write"
AFTER:  tools advertising escalation fields: ["edit","write"]
        shell.sandboxMode: "workspace-write"   fs.sandboxMode: "workspace-write"
```

So this change removes the fields from **`pwsh` only**. The assertion in the
runner is written that narrowly (`pwsh` is gone from the escalation list), and
the joint result — **zero tools advertising escalation fields** — is recorded as
a fact and explicitly *not* asserted as this task's outcome. It is a joint result
of T4 + T2 and a reader can attribute it from the table above. Note the backend
modes are unchanged (`workspace-write` in both), which is the direct evidence
that the `write`/`edit` fields are gated on the backend *capability*, not on the
preset.

---

## 4. The PTC dependency note — when it becomes safe to remove

**`run_code` is NOT in this catalog, and that is measured, not assumed.** The
BEFORE artifact reports 28 tools and `run_code` is not among them. The reason is
that the `tools` registry's presentation mode is its schema default `native`:
`packages/bundle/web-app/cordis.patch.yml` sets `mode: !!js
process.env.DSH_TOOLS_MODE`, that variable is unset on this deployment, so no
`run_code` transport is presented. **PTC is a mounted SERVICE here, not a
model-facing surface.** (The coordinator reached the same conclusion
independently.)

A later reader could easily conclude the opposite from the presence of the
`workflow` tool and try to "remove PTC" by deleting rows. The chain that must
move **together**:

```
tool-workflow  injects workflowEngine
workflow-ptc   provides workflowEngine (PtcWorkflowEngine extends WorkflowEngine,
               whose constructor publishes `workflowEngine`) and injects
               ['subagents','ptcRuntime','sandboxPolicy']
               (packages/workflow/workflow-ptc/src/index.ts:103)
ptc-runtime    provides ptcRuntime and injects
               ['fs','subprocess','sandbox','sandboxPolicy']
               (packages/ptc-runtime/ptc-runtime-node/src/index.ts:53)
```

`inject` is a **readiness gate**. A row whose injected service never publishes
stays PENDING forever, and `mountPreset` throws when ANY row is unusable
(`packages/preset/agent-presets/src/mount.ts:394-396`) — the preset then fails to
mount **entirely** and the model's tool face goes to zero. That is measured, not
inferred: removing the sandbox rows produced `toolCount: 0` with `pwsh`,
`ipython` and `work` all absent (Fact F in
`docs/decisions/AUDIT-REQUEST-nosandbox.md`; reproduced in
`qualification/results/M12-deliverable-surface/surface-MINE.json`).

**Therefore:** `workflow-ptc` and `tool-workflow` can only leave as a **pair**,
and only once `ptcRuntime` is no longer needed — which is when the IPython →
native-tool bridge is qualified and a cell can reach native tools without a
`run_code` transport. That bridge is a different agent's work. Until it lands,
leave these rows alone: deleting `workflow-ptc` alone takes `tool-workflow`
pending with it, and deleting `ptc-runtime` alone takes `workflow-ptc` pending —
either way the whole preset unmounts.

Before removing any of it, a later agent must verify: (1) the bridge is
qualified; (2) a boot probe on this preset reports a **non-zero**
`toolCountAgentKey` with the removed tool absent — the count is what separates
"removed" from "the mount died"; (3) zero "did not activate" lines.

---

## 5. The boot probe

**Files.** Probe + overlay (the named deliverables, adding no rows):
`qualification/runners/verify-t4-preset.mjs`,
`qualification/runners/verify-t4-preset.patch.yml`. Driver and artifacts:
`qualification/results/T4-preset/run-verify.mjs`, `verify-{before,after}.json`,
`boot-{before,after}.json`.

**Boot command shape** (via `qualification/runners/boot-harness.mjs`, which
binds a free port by binding it and releasing it, never by guessing):

```
node apps/cli/lib/bin.js --profile daily \
  --patch qualification/runners/verify-t4-preset.patch.yml \
  --patch <harness port patch> --no-open
DSH_HOME=D:/DSH/home/t4-preset   cwd=C:/   (FOREIGN cwd, different drive)
```

**The overlay adds NO tool row** — only the probe itself — so whatever it reports
comes from the profile's own composition. A probe that inserted a row would prove
the tool works when a row is present without proving the product carries one:
the G-FIX-04 / G-FIX-05 / G-FIX-12 defect class.

**`--dump-config` was not used.** It does not execute plugins, so it cannot prove
activation; every question here is about activation. (Confirmed independently by
the coordinator: a `--dump-config` run produces no probe artifact at all.)

**Result ownership is asserted, not assumed.** `readResult()` requires the preset
ROOTS in the artifact to name the home that was booted. Measured in both
directions as a negative control:

```
readResult(<my after-result>, 'D:/DSH/home/SOME-OTHER-AGENT')
  -> THROWS: "does not describe the home this caller booted"
readResult(<my after-result>, 'D:/DSH/home/t4-preset')
  -> ACCEPTS; roots: ...presets/ | D:/DSH/home/t4-preset/profiles/daily/presets/ | D:\DSH\home\t4-preset\.agent-presets
```

Roots read back from the AFTER result:
`D:\DSH\src\dsh-src\packages\preset\agent-presets\presets\` (shipped, system) |
`D:/DSH/home/t4-preset/profiles/daily/presets/` (deployment, system) |
`D:\DSH\home\t4-preset\.agent-presets` (user). The second names the home booted,
so the artifact is mine.

**One-variable attribution.** Several agents edited this tree concurrently, so
"28 → 27" alone is not attributable. The runner records the digest of **every
input** the boot reads. Between the two artifacts, exactly one differs:

```
DIFF  installedPreset  1e89d675d05a4e2a -> 16bc20e559d0c05b
same  installedProfilePatch, repoProfilePatch, repoPreset,
      workBundlePatch, ipythonBundlePatch, overlay
```

The delta is therefore the preset edit and nothing else. (`repoProfilePatch`
stayed at T2's in-progress digest throughout and was held constant in both runs;
`installedProfilePatch` was held at the pre-T2 state `59f23346...` in both — the
installed copy is what the boot reads, and it was not refreshed between phases.)

**Port hygiene.** Ports 11122 (before) and 8128 (after), both bound-free,
`portReleased: true` in both artifacts, and verified afterwards with `netstat`:
no listener on any port used this session. No DSH host process survives (the only
node processes left belong to another agent's vitest run and to unrelated
desktop apps).

---

## 6. What is NOT proven

- **No model turn was run.** The catalog is read from the live tool registry for
  a real Session's real Agent object — the same access path DSH's own PTC
  harvest uses — but no LLM produced a tool call. "The model is offered 27 tools"
  is proven; "the model uses `ipython` well" is not.
- **The prompt does not yet prefer IPython.** Nothing in this change makes the
  model *choose* `ipython` over the fs tools: `packages/dsh-ipython` registers no
  system-prompt section, and the layer-B prompt rewrite in
  `docs/decisions/AUDIT-REQUEST-nosandbox.md` is not done. Removing the `pwsh`
  row removes the competing shell dialect; it does not add guidance. A model that
  wants a shell now has to reach one through `import subprocess` in a cell,
  which is a weaker affordance than a purpose-built tool — that is a real cost of
  this change and it is not measured here.
- **`ipython` was not executed in this probe.** The parameter shape is asserted
  (`["code"]`, sole parameter); the cell path itself is a different gate's
  evidence (`qualification/results/M11-ipython/`, `T6-ipython/`).
- **The kernel's working directory was not verified.** Layer B2 of the audit
  ("kernel cwd is the project root") is a separate requirement and is NOT
  addressed by this change; if the kernel's cwd is wrong, Python relative paths
  land elsewhere and nothing here would catch it.
- **No POSIX claim.** `tool-bash` keeps its shipped expression and was never
  exercised on a POSIX host. On Linux this preset would still offer `bash`.
- **Not run: CPU budget.** No load-hold arm was attempted (per the coordinator's
  CPU constraint). The change is a single `disabled:` flag and there is no
  plausible load-dependent behaviour to test, but that is reasoning, not
  measurement.
- **Concurrent edits.** The tree was under concurrent edit by T2 (fs rows) and T3
  (shell/permission rows) throughout. Both of my phases booted the SAME installed
  profile patch, so my before/after pair is internally consistent — but a boot
  taken from the *repository* state right now would include their work and would
  not reproduce these two numbers. The digests in the artifacts are what make
  this checkable rather than asserted.
- **The `write`/`edit` escalation fields are still advertised** in the AFTER
  catalog. Removing them is T2's fs-provider swap, not this change. Until T2
  lands, the model still sees `sandbox_permissions` + `justification` on two
  tools — in a deployment whose architecture decision is "no sandbox". That is a
  live inconsistency in the composed product right now, and it is a joint gap,
  not a T4 one.

---

## 7. Rows for `docs/GAPS.md` (NOT applied — T4 does not own that file)

Fenced block, ready to paste into the table under
"Source-level findings that change the plan":

```
| G-SEAM-29 | **The Web bundle disables the host-plane tool rows, so the AGENT PRESET — not `profiles/daily-candidate/cordis.patch.yml` — is the file that decides the model's tool surface.** | RESOLVED — mechanism, with a boot probe | `packages/bundle/web-app/cordis.patch.yml` sets `disabled: true` on the host rows `tool-pwsh`, `tool-bash`, `tool-fs`, `tool-fs-search`, `tool-jobs`, `tool-skill`, `tool-subagent*`, `workflow-ptc`, `tool-workflow`, `tool-todo`, `tool-web`, `plan-mode`, `compaction-*` and `agent-instructions`, and lets the preset roster compose them per Session. The host `tool-pwsh` row is `disabled: true` and the model nevertheless saw `pwsh` until the preset row was disabled, because `ctx.tools` layers are keyed by the Agent object (`packages/core/agent-loop/src/agent.ts:104`) and a host-level tool row publishes into the root realm where no agent's scope selects it. Both facts are recorded in ONE artifact (`qualification/results/T4-preset/boot-before.json`, `hostRowsOfInterest` beside `tools`). Consequence: a tool-surface change written anywhere other than the preset is a change to a plane the model does not read. Evidence: `qualification/results/T4-preset/FINDINGS.md`. |
| G-SEAM-30 | **The model-facing shell is OFF in the daily preset, and this is NOT containment.** | RESOLVED — decision, with the non-claim stated | `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` sets `disabled: true` on `tool-pwsh` unconditionally; `tool-bash` keeps its shipped POSIX-only expression and is inert on Windows. Measured 28 → 27 tools with `pwsh` absent, `ipython` present, 0 activation warnings, from a foreign cwd on a bound-verified port (`qualification/results/T4-preset/verify-after.json`, 38/38 checks). The kernel is unconfined and has the same file/network authority the shell had (G-SEAM-25), so this removes a second INTERFACE, not a capability. It must not be cited as evidence that any containment exists. |
| G-SEAM-31 | **The `write`/`edit` tools still advertise `sandbox_permissions` + `justification` in a no-sandbox deployment; removing them is a fs-PROVIDER change, not a preset change.** | OPEN — joint gap (T2 + T4) | Measured in the same boot: BEFORE `["edit","pwsh","write"]`, AFTER `["edit","write"]`, with `shell.sandboxMode` and `fs.sandboxMode` both `workspace-write` in both phases. `tool-pwsh` gates on `ctx.shell.sandboxMode` (`packages/shell/tool-pwsh/src/index.ts:196`; `pwsh-sandbox` overrides at `packages/shell/pwsh-sandbox/src/index.ts:83`) — the preset removes the whole tool. `tool-fs` gates on `ctx.fs.sandboxMode` through `FsSandboxController` (`packages/fs/tool-fs/src/sandbox.ts:45`); the base class reports `undefined` and only a confining backend overrides it (`packages/fs/fs/src/index.ts:104`), so the fields are advertised by the mounted BACKEND regardless of the mode's value. Removing them requires the `fs-sandbox` → `fs-local` swap (T2's task). The joint end state is zero tools advertising escalation fields; neither change alone achieves it. |
| G-SEAM-32 | **`run_code` is NOT model-facing on this deployment, so "remove PTC" is not a catalog edit — and the `workflow-ptc`/`ptc-runtime` chain cannot be deleted piecewise.** | OPEN — dependency, recorded so it is not broken | Measured: the 28-tool catalog contains no `run_code`, because the `tools` registry mode is the schema default `native` (`packages/bundle/web-app/cordis.patch.yml` sets `mode: !!js process.env.DSH_TOOLS_MODE`, unset here). PTC is a mounted SERVICE, not a model surface. The chain that must move together: `tool-workflow` injects `workflowEngine`; `workflow-ptc` provides it and injects `['subagents','ptcRuntime','sandboxPolicy']` (`packages/workflow/workflow-ptc/src/index.ts:103`); `ptc-runtime` provides `ptcRuntime` and injects `['fs','subprocess','sandbox','sandboxPolicy']` (`packages/ptc-runtime/ptc-runtime-node/src/index.ts:53`). `inject` is a readiness gate and `mountPreset` throws if ANY row is unusable (`packages/preset/agent-presets/src/mount.ts:394-396`), so a partial deletion unmounts the whole preset — measured as `toolCount: 0` in `qualification/results/M12-deliverable-surface/surface-MINE.json`. Safe to remove only as a pair, and only once the IPython → native-tool bridge is qualified. |
```

---

## 8. Reproduce

```sh
cd D:/DSH/work/dsh-native-daily

# 1. Install the profile into T4's own home (never a shared one).
mkdir -p D:/DSH/home/t4-preset/profiles
cp -r profiles/daily-candidate D:/DSH/home/t4-preset/profiles/daily
cd D:/DSH/home/t4-preset/profiles/daily
DSH_HOME='D:\DSH\home\t4-preset' node D:/DSH/src/dsh-src/apps/cli/lib/bin.js plugin --profile daily install

# 2. Copy the preset under test into that home (this is what the boot reads).
cp D:/DSH/work/dsh-native-daily/profiles/daily-candidate/presets/daily-standard/agent.cordis.yml \
   D:/DSH/home/t4-preset/profiles/daily/presets/daily-standard/agent.cordis.yml

# 3. Boot for real, from a foreign cwd, on a bound-free port, and assert.
cd D:/DSH/work/dsh-native-daily/qualification/results/T4-preset
node run-verify.mjs after     # expect 38/38, 27 tools, pwsh absent, portReleased true
```

To reproduce the BEFORE direction, substitute the preset from
`git show HEAD:profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
(`sha256 1e89d675...`) and run `node run-verify.mjs before` (expect 35/35, 28
tools, `pwsh` present).
