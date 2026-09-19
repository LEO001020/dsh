# T17 — module identity of the RUNNING host

**Scope.** Which physical copy of each shared `@deepseek-ai/*` package the booted
host actually mounted; what the launcher identity digest covers; the first tool
call on a fresh Session and the tool count; and the ECO-07 committed-value
mismatch.

**How to reproduce.**
```sh
node qualification/runners/run-t17-identity.mjs
```
It rebuilds both extension packages, installs a fresh profile into
`D:/DSH/home/t17-identity`, boots the real built launcher on a
harness-chosen free port, and writes
`qualification/results/T17-identity/runs/built-launcher/`.

---

## 0. Which build this measured

Recorded because a sibling agent filed a stale `lib/` as a product defect today,
and the same trap applies to every gate here: a home installs the extension
packages through a `link:`, so a boot executes the BUILT `lib/`, never `src/`.

| Item | Value |
|---|---|
| Launcher | `D:/DSH/src/dsh-src/apps/cli/lib/bin.js`, sha256 `69c49c87…` |
| Rebuild before measuring | `dsh-daily-work` exit 0 (1712 ms); `dsh-ipython` exit 0 (796 ms) |
| Built `dsh-daily-work/lib/*.js` | 32 files, digest `a9a8369a…` |
| Built `dsh-ipython/lib/*.js` | 8 files, digest `04057fca…` |
| Installed profile patch | `5b8b2a8e…` — **identical to the repository's** |
| Port | 2428, harness-bound; released after the kill |
| Boot cwd | `C:/Windows/Temp` (foreign to both the repo and the profile) |

The installed-vs-repository comparison is not bookkeeping. Three sibling homes
hold three different revisions of this file (measured: `t2-fs` = `3755f904`,
`t4-preset` and `t-root` = `59f23346`, `t3-shell` = `5b8b2a8e`), so a boot of
someone else's home measures a composition that is no longer the repository's.
The driver installs its own copy and asserts the two digests are equal.

---

## 1. Which physical copy the host mounted — decided by `instanceof`

**Method.** For each package the probe resolves the BUILT entry (`lib/index.js`)
and the SOURCE entry (`src/index.ts`) as two candidate URLs, asks the running
host for the service instance it registered, and tests
`hostInstance instanceof candidateClass`. Whichever candidate the instance IS is
the copy the host loaded. The recorded realpath then names the file, and the
`instanceof` result is what makes that path trustworthy: a path pointing at a
copy the host did not load would fail the test.

This is deliberately NOT a path-substring test. An earlier agent tested
`resolvedPath.includes('/src/')` and flagged every peer, because the checkout
itself lives at `D:\DSH\src\dsh-src` and therefore every path in the tree
contains a `src` segment.

| Package | Class | Landed on | `builtMatch` | `sourceMatch` | Realpath of the copy the host mounted |
|---|---|---|---|---|---|
| `@deepseek-ai/cordis` | `Context` | BUILT | true | not tested | `D:\DSH\src\dsh-src\vendor\cordis\lib\index.js` |
| `@deepseek-ai/dsh-tools` | `ToolRuntime` | BUILT | true | not tested | `D:\DSH\src\dsh-src\packages\core\tools\lib\index.js` |
| `@deepseek-ai/dsh-agent-loop` | `AgentLoop` | BUILT | true | not tested | `D:\DSH\src\dsh-src\packages\core\agent-loop\lib\index.js` |
| `@deepseek-ai/dsh-agent` | `AgentRegistry` | BUILT | true | not tested | `D:\DSH\src\dsh-src\packages\core\agent\lib\index.js` |
| `@deepseek-ai/dsh-session` | `SessionStore` | BUILT | true | not tested | `D:\DSH\src\dsh-src\packages\core\session\lib\index.js` |
| `@deepseek-ai/dsh-subagent` | `SubagentRuntime` | BUILT | true | not tested | `D:\DSH\src\dsh-src\packages\subagent\subagent\lib\index.js` |

`sourceMatch` is `null` rather than `false` because the SOURCE candidate is
imported ONLY when the BUILT candidate does not match. That ordering is
deliberate: importing the source copy would load a second physical instance of
the package into the process and perturb the very thing being measured. The
healthy case is therefore decided without ever importing a second copy.

**Verdict: `pass: true`.** 6 of 6 peers resolved to the BUILT entry, 0 to SOURCE,
0 to a third copy, `mixedSourceAndBuilt: false`.

---

## 2. The `Symbol()`-per-module-instance root cause, measured directly

`packages/core/tools/src/index.ts:463` declares

```ts
export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@deepseek-ai/dsh-tools.scheduler')
```

**Still true in this tree** — the probe reads the declaration from the source
text rather than recalling it: `declarationKind: "Symbol"`, evidence
`Symbol('@deepseek-ai/dsh-tools.scheduler')`. It is `Symbol()`, NOT
`Symbol.for()`, so the key is PER MODULE INSTANCE.

`packages/core/agent-loop/src/tool-calls.ts:170` does
`ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)`. If the host registered
`ctx.tools` from one physical copy of `dsh-tools` while the agent loop dispatching
holds another, that lookup yields `undefined` and the run dies with
`Cannot read properties of undefined (reading 'prepare')`.

**The probe measures this by indexing the host's own service with both copies:**

| Fact | Value |
|---|---|
| `libSymbolIsSameAsSrcSymbol` | **false** — the two copies really are different symbols |
| `hostInstanceHasLibSymbol` | **true** — the host answers to the built copy |
| `hostInstanceHasSrcSymbol` | **false** — the host does NOT answer to the source copy |
| `hostInstanceSchedulerMethods` | `[prepare, dispatch, finalize, finish]` |

The `libSymbolIsSameAsSrcSymbol: false` row is what makes the other two rows
meaningful: if both copies produced the same symbol the test would be vacuous.
This is the same defect class A03 recorded for the SOURCE launcher (where the run
died at exactly this access, 3/3 runs), here shown to be ABSENT in the built
launcher — and shown by indexing, not by inference from paths.

---

## 3. Launcher identity: corrupted once, stale now

### 3.1 The corruption is resolved

`deployment.inputs.launcher_realpath` was once written with Python escape
sequences applied, so `\apps\` became BEL (0x07) and `\bin.js` became backspace
(0x08). Checked directly rather than assumed fixed:

- control characters in the recorded string: **none**;
- `launcher_realpath` = `D:\DSH\src\dsh-src\apps\cli\lib\bin.js`, which **exists**
  and hashes to `69c49c87…`, **equal** to `deployment.inputs.artifact_sha256`;
- the running process's own `process.argv[1]` realpath equals the recorded
  `launcher_realpath`.

### 3.2 The digest recomputes, and the coverage gap is the real finding

The probe reproduces Python's
`json.dumps(inputs, sort_keys=True, separators=(',',':'), ensure_ascii=True)` in
JavaScript (a boot probe must not depend on a second interpreter being on PATH)
and hashes it:

```
recorded identity   : 549732b5d8cad4e86d3df7c55dbf090598753a8fa015e8207ff6f851e376d813
recomputed identity : 549732b5d8cad4e86d3df7c55dbf090598753a8fa015e8207ff6f851e376d813
MATCH
```

Independently, `python qualification/results/T1-spec/verify-identity.py` reports
**"all 28 checks passed"**.

**But recomputing proves only that the inputs have not changed since the digest
was taken — not that the inputs are right.** So each file-named input was checked
against the file on disk separately:

| Identity input | Pinned | On disk | Match |
|---|---|---|---|
| `artifact_sha256` | `69c49c87…` | `69c49c87…` | yes |
| `dependency_lock_sha256` | `72523ca5…` | `72523ca5…` | yes |
| `agent_preset_digest` | `0934f22b…` | `0934f22b…` | yes |
| `acceptance_spec_sha256` | `2fe95835…` | `2fe95835…` | yes |
| `trusted_local_acceptance_spec_sha256` | `e5b6a1d2…` | `e5b6a1d2…` | yes |
| **`host_profile_digest`** | **`59f23346…`** | **`5b8b2a8e…`** | **NO — STALE** |

**FINDING (recorded as a FAIL, not smoothed over): the deployment identity
`549732b5…` pins a revision of `profiles/daily-candidate/cordis.patch.yml` that
no longer exists on disk.** The lock's arithmetic is internally consistent, and
the identity is exactly what the file says it is; what is stale is the VALUE of
one of its inputs. Re-deriving with the corrected pin gives
`7214021a6e89fcb71e5fe7f28ed7ced558e369bd3d308b3cd28fc890ae961082`.

This is the second half of the recorded lesson, and it is the half the scripted
recomputation cannot cover: *an identity digest proves the inputs have not
changed; it does not prove the inputs are right.* A script that recomputes the
hash will report MATCH forever while the pinned file moves underneath it.

**Not fixed here, deliberately, and the reason is scope.** Moving
`deployment.identity` invalidates every PASS recorded against `549732b5…`
(the spec's own `no_inheritance_rule`). That is an owner-level decision about
which verdicts migrate, not a probe's to make. The arithmetic, the six fields
that would move, and the re-derived value are all recorded above so the decision
can be made and applied mechanically.

---

## 4. The first tool call, on a fresh Session

A real Session was created on the profile's own default preset
(`daily-standard`), a real turn was driven through the real AgentLoop, and the
turn's durable log was read back.

### 4.1 What the model is offered

`toolCountAgentKey: 27`, in **request-header order** (not sorted — the first
entry is what the model reads first):

```
work, read, write, edit, glob, grep, job_output, job_list, job_kill, skill,
ask_user_question, web_search, web_fetch, present, ipython, read_image,
send_message, interrupt_agent, list_agents, todo_write, workflow, get_goal,
create_goal, update_goal, exit_plan_mode, subagent_fork, subagent
```

**First tool offered: `work`.**

The scope key is the AGENT OBJECT. `tools.schemas(agent.ctx)` — the wrong key —
returns **0**, measured in the same breath so the contrast stays falsifiable
rather than folklore (G-FIX-06).

### 4.2 The call that actually executed

The shipped in-tree mock fixture always calls `pwsh` on win32, and this
composition deliberately disables `tool-pwsh`. Measured: its call is refused with
`Error: unknown tool "pwsh"` / `UNKNOWN_TOOL`. That is a PASS for the composition
and a FAIL for ID-01's oracle ("the first tool call actually succeeds"), and the
two must not be conflated.

So the gate uses its own keyless adapter
(`qualification/results/T17-identity/first-call-adapter.mjs`, serving `t17-mock`)
whose first call names `read` — a tool the composition carries, and one that
crosses the `fs-local` provider swap:

| Fact | Value |
|---|---|
| `toolCallRequested` | `read`, callId `t17-first-call` |
| `toolResultIsError` | **false** |
| `toolResultText` | `<content>\n1: T17_FIRST_TOOL_CALL_ROUND_TRIP\n\n(End of file - total 1 lines)\n</content>` |
| `firstCallSucceeded` | **true** |
| `turnEndReason` | `completed` |
| identity-defect symptom | **absent** |

The result carries the file's own text, so this is not merely "a call returned" —
the call reached a real tool body, through the real scheduler, and read a real
file through the mounted filesystem backend.

---

## 5. ECO-07: the committed-value mismatch

**Adjudication: the C2 arm legitimately changed. Nothing modified the stock arm.**

### 5.1 The stock arm is intact

Every stock-arm assertion in the failing test passes, and the failure is on a
different line. `profiles/stock-canary/` is untouched (mtime 2026-09-19 11:26,
unchanged since the initial commit): its patch is still the literal empty array
`[]`, and its `package.json` still names exactly
`['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']` with no extension.

### 5.2 What actually moved, and that it is legitimate

The digest that failed is `DAILY_PATCH_SHA256`, which covers the **C2 arm**
(`profiles/daily-candidate/cordis.patch.yml`) — the arm *under test*, not the
control. It gained 258 uncommitted lines at 05:17:32 implementing DIFFERENCE
4/5/6 of the trusted-local no-sandbox decision:

| Added row | Effect |
|---|---|
| `pwsh-sandbox: disabled` + `pwsh-local` inserted | the local executor replaces the confined one |
| `permission: disabled` + `ui-permission: disabled` | the permission control plane is off (a hard constraint: `permission-presets` throws when `ctx.shell.sandboxMode` is undefined) |
| `approval: config: policy: never` | the approval policy is stated explicitly rather than inherited from an env var |

This is the project's own documented decision, and the plan names this exact
consequence as a required step:
`docs/decisions/2026-09-20-windows-nosandbox-rebuild.md` §D4 ("重推部署身份
（profile 改了，`host_profile_digest` 必变）") and §D5 ("同步 `eco.test.ts` 里 pin
的 profile digest（否则 ECO-07 会红）").

The change was never committed, so the pin was never re-derived. A sibling agent
committed the same class of re-pin before (`a1d6e6d`, "re-pin the profile digest
after the profile legitimately changed"), which is the precedent this follows.

### 5.3 A provenance error in the test, corrected

The constant's comment claimed it was "M0.5's recorded digest of the
daily-candidate profile patch". **That is false.** M0.5 recorded digests of the
three SHIPPED profile dumps only (`b64151b3…` web, `f89b4e81…` headless,
`d8929cea…` sdk); `grep 59f23346 qualification/results/M0.5-*` returns nothing.
The value was derived at `084bb23`, where the patch was last edited.

The wrong comment made the pin read like a historical record that must never
move. It is corrected to say what it is: the digest of the C2 arm as of the last
profile edit, re-derived and justified each time the arm changes.

### 5.4 What was NOT done

- The pin was **not** replaced by a computed value. A digest recomputed at
  runtime would agree with whatever the file happened to contain and would catch
  nothing. It stays a literal so the next change fails loudly.
- The stock-arm assertions were **not** weakened; they still pass unchanged.
- `qualification/gates.json` was **not** regenerated. Regenerating it with
  `build-gates.py` would re-label all 85 old PASSes with the CURRENT identity,
  which is precisely the inheritance the spec forbids
  (`no_inheritance_rule`: "NO PASS IS INHERITED"). It also silently dropped a
  hand-added reachability caveat from the C01 note. The regeneration was
  reverted; `gates.json` is byte-identical to HEAD.

**Result:** `src/eco.test.ts` 36/36 (was 35/36).

---

## 6. Gate table

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | Every shared package the host mounted is ONE physical copy | **PASS** | 6/6 peers BUILT, 0 SOURCE, 0 third copy, `mixedSourceAndBuilt: false` |
| 2 | The `TOOL_RUNTIME_SCHEDULER` key is per-module-instance | **PASS** | `declarationKind: Symbol`; lib and src symbols differ; host answers lib only |
| 3 | The launcher's recorded realpath is not corrupted | **PASS** | zero control bytes; realpath exists; sha256 = `artifact_sha256` |
| 4 | The running process IS the launcher the lock names | **PASS** | `process.argv[1]` realpath = recorded `launcher_realpath` |
| 5 | The recorded identity recomputes under its declared algorithm | **PASS** | recomputed = recorded = `549732b5…`; `verify-identity.py` 28/28 |
| 6 | Every file-named identity input matches the file on disk | **FAIL** | `host_profile_digest` pins `59f23346…`; disk is `5b8b2a8e…` |
| 7 | The first tool the model can call, and the tool count | **PASS** | 27 tools, first offered `work`; context key = 0 (G-FIX-06 contrast) |
| 8 | The first tool call actually SUCCEEDS | **PASS** | `read` returned the file's own text; `turnEndReason: completed` |
| 9 | The tree does not mix `src` and `lib` | **PASS** | `mixedSourceAndBuilt: false` |
| 10 | ECO-07's committed-value mismatch is adjudicated | **PASS** | stock arm intact; C2 arm legitimately changed; pin re-derived; 36/36 |
| 11 | The deployment identity pins the composition on disk | **FAIL** | same fact as row 6, restated: `549732b5…` describes a profile revision that no longer exists |

**11 rows: 9 PASS, 2 FAIL.** Rows 6 and 11 are the same underlying fact counted
once as a coverage check and once as an identity claim.

**Blocked, not attempted.** No claim is made about a live-provider turn: budget
is not authorized (`live_provider_budget_authorized: false`), so §4 is a
CONTROLLED LOCAL ROUTE measurement — it proves the tool/transport/identity chain,
not a provider integration.

**What row 6 does NOT say.** It does not say the lock is wrong to exist, nor that
the arithmetic is broken. The identity is exactly what its inputs hash to. What
is stale is one input's VALUE, and the consequence is that a PASS recorded
against `549732b5…` is a statement about a composition that is no longer on disk.

---

## 7. Files

| Path | What it is |
|---|---|
| `qualification/results/T17-identity/probe-plugin.mjs` | the in-process probe (runs inside the host) |
| `qualification/results/T17-identity/first-call-adapter.mjs` | keyless adapter whose first call names `read` |
| `qualification/results/T17-identity/overlays/smoke-overlay.yml` | the boot overlay |
| `qualification/runners/run-t17-identity.mjs` | the driver (rebuild, install, boot, judge) |
| `qualification/runners/boot-harness.mjs` | shared port-safe harness; gained an `env` option |
| `qualification/results/T17-identity/runs/built-launcher/verdict.json` | the judged artifact (29 checks) |
| `qualification/results/T17-identity/runs/built-launcher/boot.json` | the raw probe output |
| `qualification/results/T17-identity/runs/built-launcher/boot-stderr.txt` | the boot's own stderr |
