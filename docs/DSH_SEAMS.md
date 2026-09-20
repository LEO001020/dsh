# DSH_SEAMS — verified interface map (part 2: profile, preset, storage, Goal, terminal, PTC, tools, testkit)

Commit: `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)
Checkout: `D:\DSH\src\dsh-src`
Part 1 (subagent subsystem) is at the top of this file.

All entries **READ** unless marked otherwise.

---

## 3. Host profile and agent preset

### 3.1 Profile discovery (READ)

- Profiles live at `<home>/profiles/<name>` — `PROFILES_DIR = 'profiles'` and
  `PROFILE_PATCH_FILENAME = 'cordis.patch.yml'` at
  `packages/boot/app-boot/src/profile.ts:50,53`.
- `resolveProfileDir(name, home = resolveDshHome())` at `profile.ts:125-132`;
  rejects empty, `/`, `\`, `.`, `..`, `node_modules` in the name.
- **Home env var is `DSH_HOME`** — `packages/util/home-paths/src/index.ts:18`
  (`DSH_HOME_ENV = 'DSH_HOME'`). Default when unset is `join(homedir(), '.dsh')`
  (`:61-63`). Precedence (`:87-91`): explicit configured path > `$DSH_HOME` >
  `~/.dsh`. A whitespace-only `$DSH_HOME` counts as unset. `~` prefixes expand.
- Home-level patch file is `<home>/cordis.patch.yml` —
  `apps/cli/src/profile-boot.ts:75-77`.
- Shipped profile templates — `profile.ts:135-151`:
  `acp: [dsh-base, dsh-acp-app]`, `web: [dsh-base, dsh-web-app]`,
  `headless: [dsh-base, dsh-headless]`, `sdk: [dsh-base, dsh-sdk-app]`,
  `sdk-minimal: [dsh-sdk-minimal]`.
- `initProfile()` at `profile.ts:197-216` writes `package.json`,
  `cordis.patch.yml` (template is `[]`) and `pnpm-workspace.yaml` with
  `nodeLinker: hoisted`. **Existing files are never overwritten.**
- Bundle resolution is **installation-first, then profile**
  (`profile.ts:856-867`, doc `:844-855`): `resolveBundleDir` tries the install
  anchor first. In-box bundles therefore always come from the running dsh
  installation, never a profile-local copy. This is why a user profile cannot
  shadow a shipped bundle.

### 3.2 `dsh.profile.bundles` (READ — premise correction)

There is **no** Zod/Schemastery schema for this field. It is a plain TS interface
(`packages/util/package-manifest/src/types.ts:57-61`):
```ts
export interface DshProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[]
}
```
Runtime validation is a hand-written JSON-object check only
(`readProfileManifest`, `profile.ts:768-782`). `@deepseek-ai/dsh-package-manifest`
has **no runtime exports**. `manifestVersion`/`engines.dsh` are declarative only —
`packages/util/package-manifest/README.md:91`: *"Current installers and loaders do
not enforce `dsh.manifestVersion` or `engines.dsh`."*

**Bundle order = array order, full stop** (`profile.ts:886-896`). Writers append,
never sort (`profile-plugins.ts:113-116`, `plugin-manager/src/operations.ts:77-96`).

### 3.3 Composition order (READ — CONFIRMED)

`packages/boot/app-boot/src/profile-context.ts:63-75`:
```ts
const patches = structuredClone([
  ...profile.layers.flatMap(layer => layer.patches),
  ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
  ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
  ...context.overlays,
])
```
Order is `bundles → profile patch → home patch → CLI patch`, then a telemetry
switch appended last. Applied as **one flattened array in a single
`applyEntryPatches` call**.

### 3.4 Patch `config` is WHOLE-VALUE REPLACEMENT (READ — CONFIRMED)

`vendor/include/src/index.ts:120-123`:
```ts
for (const [key, value] of Object.entries(overrides)) {
  if (key === 'id') continue
  target[key] = value
}
```
`config` is just another key in `overrides` (`:77`), so `target.config = <new>`
replaces wholesale. Documented in prose at `vendor/include/src/index.ts:43-56`,
`packages/bundle/base/cordis.patch.yml:6-10`,
`packages/bundle/web-app/cordis.patch.yml:5-6`, `apps/cli/reference/README.md:9`,
`docs/user/develop/basic/publish.md:123`.

Other patch semantics: `insert` with `id` targets a **group** row and appends to
its `config` array; without `id` it appends at top level (`:79-102`). Inserted rows
are indexed immediately, so a later patch in the same list can target a row an
earlier patch inserted (`:95-101`). A `name` field on a patch is an **assertion** —
mismatch warns and skips (`:115-118`).

### 3.5 Agent presets (READ)

Location: `packages/preset/agent-presets/presets/`.
**Shipped IDs are exactly four: `cordis`, `minimal`, `ptc`, `standard`**
(`tests/shipped-root.spec.ts:92`, `src/display.ts:39-44`). The README mention of a
`code` preset (`README.md:180`) is **stale**.

Files: `agent.cordis.yml` (required — its presence is what makes a directory a
preset, `src/discovery.ts:37`) and `preset.yml` (optional,
`src/metadata.ts:25`). `preset.yml` shape (`metadata.ts:28-39`):
`{ name?, description?, order? }`, hand-rolled, degrades to `{}` on any failure.

**No `extends` mechanism — CONFIRMED twice.** No such field exists in code, and
`packages/preset/agent-presets/README.md:180` states it as a deliberate
limitation: *"there is no patch semantics at this layer to express 'standard plus
one change'"*. Authoring is copy-only (`src/authoring.ts:127-165`).

**Shipped shadows user of the same name — CONFIRMED.**
`src/index.ts:181-185` builds roots as `[shipped, ...config.roots, ...user]`, and
`discoverPresets` takes first-wins (`src/discovery.ts:324-337`):
```ts
if (byId.has(preset.id)) continue
```
User presets live at `<dshHome>/.agent-presets/<id>/` — **not** `profiles/`
(`USER_PRESET_DIR = '.agent-presets'`, `discovery.ts:51`). Preset id pattern
`/^[a-z0-9][a-z0-9-]*$/` (`src/preset.ts:18`).

Roster config **is** Schemastery (`src/index.ts:108-116`):
`{ default: string (required), roots: [{path, trust: 'system'|'user'='user'}], includeShippedRoot: true, includeUserRoot: true }`.

### 3.6 The web-app bundle hands the agent plane to presets (READ — load-bearing)

`packages/bundle/web-app/cordis.patch.yml:377-503` sets `disabled: true` on the
base's model-facing rows — `tool-bash`, `tool-pwsh`, `tool-fs`, `tool-fs-search`,
`tool-subagent*`, `workflow-ptc`, `tool-workflow`, `tool-todo`, `tool-web`,
`plan-mode`, `compaction-basic`, `tool-result-pruner`, `agent-instructions`,
`command-goal`, `tool-goal`, `skill-filesystem`, … — because each Web session
mounts a **preset** instead. The comment (`:384-386`) explains disabling rather
than deleting: *"the base is shared, and a row absent from a surface overlay would
silently reappear the day someone reorders the composition."*

Final row (`:512`) mounts the roster: `agent-presets` with `default: standard`.

**Consequence for this project:** in the Web profile, the agent-scoped tool set
comes from the preset, not the base bundle. Our `dsh-daily-work/tools` consumer
therefore belongs in a **preset**, and the `work` host service belongs in a
**bundle/profile patch**.

### 3.7 `maxActiveSubagents` is NOT overridden by the shipped base bundle (READ)

`packages/bundle/base/cordis.patch.yml:336-337` loads `@deepseek-ai/dsh-subagent`
with no config block, so the effective value is the source default **8**. N=10
requires an explicit override in our profile patch. This is the concrete C0
capability gap.

---

## 4. storageDomain (READ — several premise corrections)

### 4.1 Two services, and the methods are on the table, not the service

- Hub `ctx.storage` — `packages/storage/storage/src/index.ts:47-93`. Performs no IO.
- Domain facility `ctx.storageDomain` — `packages/storage/storage-domain/src/index.ts:69-197`:
  `open<S extends DomainSpec>(spec: S): Promise<Domain<S>>` (`:103`),
  `get(name): DomainImpl | undefined` (`:184`), `closeAll(): Promise<void>` (`:194`).

**`Domain` has no `spec` member.** `packages/storage/storage-domain/src/domain.ts:97-119`:
```ts
export interface Domain<S extends DomainSpec> {
  readonly name: string
  readonly global: DomainGlobalHandleOf<S>
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>
  close(): Promise<void>
}
```
The spec is the **argument** to `open`.

`KvTable` — `domain.ts:42-90`:
```ts
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}
```

### 4.2 `update` purity is stated (READ)

`domain.ts:83-88` verbatim:
> Atomic read-modify-write on the domain's write chain: fn sees the value current
> at its queue slot, so concurrent updates never interleave.
> `@param fn` - **Synchronous pure transform** from current to next record.

**The serialization is per-DOMAIN, not per-key, and that is the load-bearing
detail for any admission or reservation design.** `domain.ts:3` says "per-domain
write chain"; `:125-126` is `enqueue<T>(job)` — "Queue one job on the domain's
single write chain"; the private implementation is `:263`. So every `update()` on
one domain is ordered against every OTHER update on that same domain, including
updates to different keys. A read-modify-write therefore cannot race with a
sibling read-modify-write anywhere in the domain, which is why a
`tryReserveAdmission`-style operation can be correct with no lock of its own: it
reads occupancy from the `current` it is handed and cannot observe a stale value.

Two consequences follow from the same fact:

- **`fn` must stay synchronous and pure.** Because the chain is per-domain, a
  slow or awaiting `fn` would stall every other write to the domain, and the
  interface does not prevent returning a promise — it would be stored as a record
  value verbatim (`:332-346`). Any async input (a budget lookup, a clock read)
  must be resolved BEFORE the update and passed in.
- **A counter read outside the update is not authoritative.** A generation or
  occupancy value is only meaningful if it is read and written inside the same
  `fn`; reading it outside and acting on it reintroduces the check-then-act race
  the atomic update exists to remove. That is the shape of `G-SEAM-45`: the
  budget check sat inside the record update and did not race, while the target
  check sat outside it and over-admitted.

Enforced structurally at `domain.ts:332-346` (`const next = fn(this.records.get(key) as V)`).
A returned `Promise<V>` would be stored as a record value verbatim — the type is
the only enforcement. **This is INV-D2.**

Immutability (`domain.ts:37-41`): *"returned values are the stored objects
themselves (no defensive copies) and must not be mutated in place — replace via
put/update."* **INV-D2.**

Missing key → `DomainError('missing-key')` (`:335-338`). `delete` of an absent key
returns `false`, no write, no event (`:315-330`).

### 4.3 Schema validators split (READ — CONFIRMED)

`packages/storage/storage-domain/src/spec.ts:5-7` verbatim:
> Record schemas are **zod** … plugin Config stays **schemastery**.

`DomainTableSpec.valueSchema: ZodType<V>` (`spec.ts:29`). Validation runs **at
open**, `tableSpec.valueSchema.parse(raw)` (`storage-domain/src/index.ts:126`),
wrapped into `DomainError('invalid-record')` (`:200-211`). **Not re-checked on
write** (documented `domain.ts:30-31`).

Real consumer example — `packages/workspace/workspace/src/spec.ts:22-28,68-76`.

### 4.4 JSON backend (READ)

`@deepseek-ai/dsh-storage-json`, backend name `json` (`storage-json/src/index.ts:112`).
Config `{ root: string }` — **no default on purpose** (`index.ts:24-36`): *"a
`process.cwd()` fallback would scatter unit files wherever the process happens to
start."* Shipped value `root: dshHomePath('storages')` and
`storage-domain.backend: json` (`packages/bundle/base/cordis.patch.yml:155-160`).

Durability — `storage-json/src/atomic.ts:24-40`: temp file → `handle.sync()` →
`rename` → `fsyncDirectory`. **`fsyncDirectory` early-returns on win32**
(`atomic.ts:44-45`): `if (process.platform === 'win32') return`.

Gap (READ): per-record `deleteRecord` is a bare `rm(..., { force: true })` with no
fsync (`per-record-unit.ts:228`).

### 4.5 No locking, no host lease (READ — IMPORTANT)

`packages/storage/storage-json/README.md:142`:
> **No cross-process write locking** — two processes writing the same unit can
> interleave replacements; writes to the same file use last-completion wins.

`storage-domain/README.md:151`: *"**Single-process change visibility** —
`domain/changed` is an in-process event."*

`grep -riE "\blease\b"` over the repo finds **no host lease**. The only real lease
is `SessionWriteLease` in `packages/session/session-persistence-jsonl/src/lease.ts`
— a per-session cross-process kernel lock (`flock` on POSIX, a named kernel
semaphore on Windows), with **deliberately no expiry** (`lease.ts:10-13`).

**This is exactly the delivery plan's INV-D7 and gate D02.** There is no global
guarantee to lean on, so the second host must be blocked at the deployment
boundary — by our own means, not by an upstream lease.

### 4.6 Double-open rejects (READ)

Three layers, each with its own error:
- Facility: `if (this.reserved.has(spec.name)) throw new DomainError('already-open', ...)`
  (`storage-domain/src/index.ts:104-106`). Released only after full teardown
  (`:156-159`), so a *closing* domain also rejects.
- JSON backend: `unit '<name>' is already open; a unit has exactly one live handle`
  (`storage-json/src/index.ts:54-57`).
- Backend contract: `packages/storage/storage/src/backend.ts:36-38` —
  *"Opening the same unit name twice without closing is a caller bug and rejects."*

`DomainErrorCode = 'already-open' | 'facet-unsupported' | 'invalid-record' | 'missing-key' | 'closed'`
(`storage-domain/src/error.ts:7-12`).

---

## 5. Goal (READ)

`ctx.goals` — `packages/goal/goal/src/index.ts:240`, class `GoalService`.

| Line | Signature |
|---|---|
| `:276` | `get(agent: Agent): GoalView \| undefined` |
| `:289` | `disarm(agent: Agent): GoalView \| undefined` |
| `:303` | `create(agent, request: CreateGoalRequest): GoalView` |
| `:328` | `edit(agent, ref: GoalRef, request: EditGoalRequest): GoalView` |
| `:351` | `pause(agent, ref: GoalRef): GoalView` |
| `:363` | `resume(agent, ref: GoalRef): GoalView` |
| `:390` | `complete(agent, ref: GoalRef): GoalView` |
| `:409` | `block(agent, ref, reason: GoalBlockReason): GoalView` |
| `:432` | `clear(agent, ref: GoalRef): GoalRef` |

All mutations are **synchronous** (they commit into the session log synchronously
via `agent.session.append`, `:613`). Config:
`{ defaultMaxGoalRounds: z.number().default(256) }` (`:243-245`).

`GoalRef` — `types.ts:19-25`: `{ id: GoalId; revision: number }`, revision is
"positive; every durable mutation increments it".

CAS — `expectCurrent` (`index.ts:456-466`) throws
`GoalError(..., 'GOAL_STALE_REVISION')` when `ref.id`/`ref.revision` disagree.
Every transition does `revision: current.revision + 1` (`:518-526`). Codes at
`domain.ts:97-106`.

Durability: **not** in the storage domain — event-sourced over the session log
(`goal/change` events, `domain.ts:57-64`, folded by `goalProjectionDefinition`,
`index.ts:162-169`, `stateVersion: 6`).

### `disarm` vs `pause`/`complete` (READ — this decides M3's design)

`index.ts:282-294`:
```ts
/**
 * Remove process-local continuation authority without changing durable goal
 * phase or revision. Lifecycle owners use this before unloading a driver;
 * a later human-authorized resume records the new activation edge.
 */
disarm(agent: Agent): GoalView | undefined {
  this.assertLive(agent)
  this.setActivation(agent.session, 'disarmed')
  const runtime = this.runtimeState(agent.session)
  return this.view(this.state(agent.session), runtime)
}
```
`setActivation` (`:496-515`) only flips the process-local activation and emits
`goal/activation-changed` — **no `session.append`, no revision bump**. Activation
is explicitly "process-local (never persisted)" (`types.ts:97-98`).

`pause` (`:351-354`) is `transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')`
— durable phase change, revision+1, **and** disarm. `complete` (`:390-400`) is the
same shape. `resume` (`:363-382`) is the only re-arm path and rejects re-arming an
already-active+armed goal (`:372-374`).

**So the delivery plan's M3.5 design is exactly expressible:**
`ctx.goals.disarm(root)` removes automatic continuation without touching the
objective or faking completion. **INV-G2.**

### Goal round driver is idle-follow-up, not a scheduler (READ — CONFIRMED)

`packages/goal/goal-round-driver/src/index.ts` (456 lines):
- **Zero timers.** `grep -rn "setTimeout|setInterval"` over `packages/goal/**`
  (excluding tests) returns nothing.
- Gate `readyToDrive` (`:103-109`) requires
  `ctx.agents.get(state.agent.id) === state.agent && state.agent.status === 'idle' && !state.competingQueued`.
- All entry points are listeners: `agent/status` (`:258-281`),
  `goal/changed` (`:282-293`), `agent/inbox/*` (`:295-316`),
  `session/event` (`:318-342`), `agent/error` → disarm (`:246-249`).
- It calls `agent.followup(message)` (`:192`) — injects a follow-up, does not start
  a turn itself.
- Only an **admitted** `user/message` consumes the round cap (`:323-327`;
  `packages/goal/goal/src/fold.ts:321-331`). README `:71` confirms.

Contrast: the actual wall-clock scheduler is `packages/schedule/`
(`schedule/src/runtime.ts:273` uses `agent.followup` on a timer).

---

## 6. Terminal (READ)

### 6.1 `ctx.terminals` — agent-owned

`packages/terminal/terminal/src/index.ts:48-52,116`. Methods:

| Line | Signature |
|---|---|
| `:125` | `registerBackend(backend: TerminalBackend): () => void` |
| `:143` | `listBackends(): string[]` |
| `:154` | `async spawn(owner: Agent, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult>` |
| `:231` | `hasOwnerActivity(owner: Agent): boolean` |
| `:243` | `startSend(owner, id, request: TerminalSendRequest): TerminalSendOperation` |
| `:263` | `read(owner, id, request?: TerminalReadRequest): TerminalReadResult` |
| `:274` | `signal(owner, id, signal: TerminalSignal): Promise<TerminalSignalResult>` |
| `:285` | `async kill(owner, id, reason = 'model request'): Promise<boolean>` |
| `:308` | `list(owner: Agent): TerminalSessionSnapshot[]` |

**Spawn spec is exactly `{type, name?, cwd?}` — no `command` field** (READ,
`types.ts:43-51`). Ids are minted `pty-${++this.nextId}` (`index.ts:166`).

Wait reasons — `types.ts:29`:
```ts
export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'
```
Status — `types.ts:39-41`:
```ts
export type TerminalSessionStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }
```
`TerminalSendResult` (`types.ts:82-91`): `viewport`, `waitReason`, `sessionStatus`,
`truncated`. `TerminalReadResult` (`types.ts:112-123`): `text`, `totalLines`,
`lineBegin`, `lineEnd`, `truncated`. `TerminalSendOperation` (`types.ts:94-101`):
`done: Promise<TerminalSendResult>`, `readOutput()`, `cancel(): boolean`.

**These four wait reasons are exactly what INV-T1 forbids treating as cell success.**

### 6.2 `ctx.terminalController` — human Web terminal, system-user, unsandboxed

`packages/api/terminal-controller/src/index.ts:102`, namespace `terminal`. READ:

- `index.ts:1`: *"Session-owned user terminals with the execution environment's
  **system-user permissions**."*
- `index.ts:151`: *"Allocate a user shell once for a caller-generated identity,
  **without Agent sandbox or approval restrictions**."*
- `index.ts:346-351` spawns via `subprocess.spawnTerminal(...)` with **no
  `sandbox.confine` call anywhere in the package**.
- `README.md:30`: *"User terminals run with the execution environment's system-user
  permissions, independently of the Agent's sandbox mode and approval policy."*
- Test pin — `tests/controller.spec.ts:283`: `it.each(['read-only','workspace-write','danger-full-access'])('starts a user shell without confinement under %s Agent permissions')`.

**Confirmed: two distinct services with different powers.** Wrapping the second as
a model tool is privilege escalation — **INV-S1**, gates E02/T02.

### 6.3 Windows shell backend (READ — important for M6)

- Only **one** backend package exists: `BashTerminalBackend implements
  TerminalBackend` (`packages/terminal/terminal-bash/src/index.ts:184`).
- Dialects `ShellDialect = 'bash' | 'pwsh'` (`terminal-bash/src/config.ts:7`),
  selected by `shellDialect` (default `'bash'`). **No `cmd` dialect.**
- Windows uses the *same* package with `shellDialect: pwsh`
  (`packages/preset/agent-presets/presets/minimal/agent.cordis.yml:50-55`,
  `disabled: process.platform !== 'win32'`), asserted by
  `apps/cli/tests/windows-shell.spec.ts:146-157`.
- pwsh resolution candidates — `packages/shell/pwsh-local/src/resolve.ts:21-37`:
  `%ProgramFiles%\PowerShell\7\pwsh.exe`, PATH, then
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (5.1 fallback).
- `dsh-tool-terminal` (the six `terminal_*` tools) is mounted **only** by the
  snapshot `snapshots/session/pty-tools-sandbox-backend/cordis.yml:15-16` — **no
  shipped preset or bundle row mounts it**. The shipped `minimal` preset instead
  mounts `@deepseek-ai/dsh-tool-bash-persistent` / `-pwsh-persistent`
  (`agent.cordis.yml:36-69`). This is a **GAP for M6/T01** and must be re-verified
  by resolving the actual profile.

### 6.4 Terminal backend config defaults (READ)

`packages/terminal/terminal-bash/src/config.ts:84-100`:
```ts
timeoutMs: z.number().default(30_000),
idleSilenceMs: z.number().default(3_000),
handoffGraceMs: z.number().default(500),
pollIntervalMs: z.number().default(50),
exactProbeAfterMs: z.number().default(150),
disposeGraceMs: z.number().default(3_000),
```
Consumption: absolute deadline at `session.ts:354-360`; inferred idle at
`session.ts:586-589`:
```ts
const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
if (startupHasOutput && idleFor >= this.config.idleSilenceMs + handoffGrace) this.settleActive('inferred_idle')
```
Confirmed in `terminal-bash/README.md:57` (`| timeoutMs | 30000 |`).

**The model's `terminal_send` has no per-call timeout field** — changing it means
changing backend config. **INV-T1/T2 support.**

---

## 7. PTC runtime (READ)

`packages/ptc-runtime/ptc-runtime/src/index.ts:91-95,104,134`:
```ts
abstract readonly language: string          // :114
abstract readonly isolation: string         // :122
get executionInstructions(): string { return '' }          // :125
get sandboxMode(): SandboxMode | undefined { return undefined }  // :128
get timeout(): { defaultMs: number; maxMs: number } | undefined { return undefined } // :131
abstract resolve(request: PtcRunRequest): PtcRunSpec        // :143
abstract run(spec: PtcRunSpec): Promise<PtcRunResult>       // :150
```
`PtcRunRequest` (`types.ts:73-98`): `program`, `bindings`, `cwd?`, `timeoutMs?`,
`sandboxPolicy?`, `signal?`. `PtcRunSpec` adds required `cwd` and `timeoutMs`.
`PtcRunResult` (`types.ts:144-162`): `sandbox?`, `value?`, `logs`, `error?`.
Failure kinds (`types.ts:132-137`): `'exception' | 'timeout' | 'abort' |
'worker-exit' | 'invalid-output' | 'output-limit' | 'protocol' | 'sandbox-unavailable'`.

Backends:
- `NodePtcRuntime` — `@deepseek-ai/dsh-ptc-runtime-node`, `language = 'typescript'`,
  `isolation = 'process'`. **Released and mounted by base**
  (`packages/bundle/base/cordis.patch.yml:376-377`).
- `PythonPtcRuntime` — `@deepseek-ai/dsh-experimental-ptc-runtime-python`.
  Source says `:800-801`: *"The experimental {@link PtcRuntime} backend (private,
  not released)"*, and `ptc-runtime/src/index.ts:111-112` says the Python backend
  is experimental and private. **Nuance (READ):** the mechanical publication policy
  `scripts/experimental-package-policy.ts:2` has an **empty**
  `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES`, so the checker actually requires that
  package to be non-private with `publishConfig.access: "public"` — which its
  `package.json:41-43` satisfies. Record both; do not collapse them. It also
  refuses non-Unix platforms (`:838`), so it is unusable here regardless.
  No shipped profile mounts it.

`ctx.codeRuntime` / `code-runtime` — **REFUTED, zero source hits.** The rename is
recorded as implemented in
`.agents/notes/implemented/architecture/2026-09-12-ptc-runtime-vocabulary.md`:
*"no compatibility package or second service registration is supplied."* Residual
hits are only in frozen `.agents/notes/archived/**` and a stale generated
`docs/dependency-catalog.json` describing `dsh@0.1.5-rc.1`.

Note: `@deepseek-ai/dsh-workflow-ptc` hard-requires
`language === 'typescript'` (`packages/workflow/workflow-ptc/src/index.ts:117`).

---

## 8. Tool protocol (READ)

### 8.1 `defineTool`

`@deepseek-ai/dsh-tools` (`packages/core/tools`), re-exported from `src/index.ts:59-82`.
`src/schema.ts:545-547`:
```ts
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition
```
`DefineToolOptions` (`schema.ts:483-536`): `name`, `description`, `parameters`,
`output: { schema, render(args, value): ContentBlock[], presentationMeta? }`,
`timeoutMs?`, `isConcurrencySafe?(args)`, `execute(args, exec: ToolRunContext)`,
`finalizeContent?`, `presentCall?(args)`, `presentResult?(args, result)`.

Runtime (`schema.ts:563-617`): `execute` validates args first and throws
`ToolArgsError(violations)`; `output.render` is always called with `(args, value)`;
`presentCall`/`presentResult` validate softly and return `undefined` on mismatch.
Registration is `ToolRuntime.register(definition): () => void` (`src/index.ts:1043`),
which **throws if `output.render` is not a function** (`:1046-1050`) and reserves
the name `run_code` (`:1059-1062`).

Real minimal example — `packages/terminal/tool-terminal/src/index.ts:387-398`.

### 8.2 `ctx.tools.guard()` — monotonic, synchronous deny (READ — CONFIRMED)

`packages/core/tools/src/index.ts:705-713`:
```ts
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```
`guard(guard: ToolGuard): () => void` (`:1116-1122`). Plain context = global;
registered via `agent.ctx` = that agent only. No guard can force-allow
(`:1106-1115`). Resolution order: global layer first, then the scope chain
farthest-first (`:1124-1134`). **INV-L6.**

### 8.3 Tool events (READ — modes matter)

```ts
'tools/pre-execute'(exec, next): Promise<PreToolDecision>     // index.ts:146  waterfall
'tools/execute'(exec, next): Promise<ToolExecutionResult>     // :157  waterfall
'tools/post-execute'(exec, result, next): Promise<PostToolDecision> // :169  waterfall
'tools/ptc-dispatch-log'(dispatch, next): Promise<ContentBlock[]>   // :183  waterfall
'tools/result'(exec, result): undefined                        // :191  emit
'tools/change'(): void                                        // :201  emit
```
Decisions (`:589-602`): `PreToolDecision = {kind:'allow'} | {kind:'deny'; reason; info?} | {kind:'cancel'} | {kind:'ask'; reason?}`;
`PostToolDecision = {kind:'accept'; content?} | {kind:'accept'; value} | {kind:'block'; feedback}`.

**`tools/result` is emitted with a deep-frozen snapshot; listener failures are
contained** (`index.ts:1672-1675`). It is an observation, not a transaction
participant — **INV-L5 / gate B08.**

### 8.4 PTC nested dispatch cannot escape the tool runtime (READ)

`index.ts:323-332`: only a call carrying a `parent` token may execute a native tool
name under `mode: 'ptc'`. This supports INV-C7's "PTC calls still go through the
same ToolRuntime".

---

## 9. Agent loop and lifecycle events (READ — several premise corrections)

Production loop: `@deepseek-ai/dsh-agent-loop`, `packages/core/agent-loop/`.
`class AgentLoop extends Service implements AgentFactory` (`src/index.ts:359`),
`static inject = ['agents','sessions','llm','tools','systemPrompt','sessionProjections']`
(`:360`), registers itself as factory at `:421`. Driver `ReactLoopAgent`
(`src/agent.ts:72`). Main loop `kick()` = `while (await this.turn()) {}`
(`agent.ts:226-239`).

Event modes (`packages/core/agent/src/runtime-types.ts:245-395`):
```ts
'agent/created'        // :261  serial
'agent/disposed'       // :270  emit
'agent/status'         // :280  emit   { agent, status: 'idle'|'running' }
'agent/inbox/inserted' // :288  emit
'agent/inbox/claimed'  // :299  emit
'agent/inbox/discarded'// :307  emit
'agent/pre-step'       // :320  waterfall
'agent/request'        // :337  waterfall
'agent/request-error'  // :353  waterfall
'agent/assistant-stream' // :363 emit
'agent/turn-stopping'  // :381  serial
'agent/error'          // :393  emit
```
**There is NO `agent/idle` event** — idle is `agent/status` with `status === 'idle'`.
`agent/created` and `agent/disposed` are emitted by the **registry**
(`packages/core/agent/src/index.ts:547`, `:511`), not the loop.

`agent/turn-stopping` (`runtime-types.ts:381`):
```ts
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
```
Doc (`:364-380`): *"Awaited before the boundary commits — a listener that objects
steers (`agent.steer(...)`) and the machine re-reads its inbox… **Data decides, so
listener order cannot change the outcome.**"* Dispatch at `agent.ts:316-319`,
guarded by `turnEnds && this.inbox.nextStep.length === 0`. **INV-L5 / F06.**

### 9.1 Wake semantics (READ — decisive for M3.4)

`packages/core/agent/src/runtime-types.ts:217-241` verbatim:
- **`followup(message)`** — *"Queue an ordinary follow-up turn **and wake the
  driver**. The item becomes the sole ordinary message of its own turn."* → wakes.
- **`steer(message)`** — *"Submit steering for the nearest step. **An idle driver
  starts a turn**…"* → wakes. Returns `void`.
- **`inject(message)`** — *"Queue model-facing context for the next pre-step
  **without waking the driver**. A running driver claims it at the nearest later
  step boundary; **idle drivers leave it pending until follow-up or steering wakes
  them**."* → does not wake.

Implementation `agent.ts:128-147`: `followup` → `send(input,'next-turn',true)`,
`steer` → `send(input,'next-step',true)`, `inject` → `send(input,'next-step',false)`.

**This is exactly why the delivery plan says "inject itself does not wake, so you
cannot inject and then wait for a miracle".** M3.4 must use followup/steer to wake.

`whenIdle()` (`:185-191`): *"does not identify the settlement of any particular
message."*

**There is no `agent.dispose()`.** Teardown is `AgentHandle.dispose()`
(`packages/core/agent/src/index.ts:160-163`): *"stops the loop, awaits its exit,
unregisters the agent, removes its session from the store, and finally unwinds its
scoped world."* Per-agent cancellation is `cancel(cause, options?)`
(`runtime-types.ts:183`). **INV-L4 / INV-L3.**

### 9.2 `ctx.agents.create` meta (READ — `cwd` lives here, not in AgentOptions)

`packages/core/agent/src/index.ts:78-85`:
```ts
readonly meta?: {
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly isSeeded?: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}
```
Doc (`:66-77`): *"This is durable session data, so the session boundary validates
and snapshots it before asynchronous setup begins."*

Header meanings (`packages/core/session/src/types.ts:93-130`):
- `parentSession` (`:105-106`): *"The session this one was forked from (seed lineage)"* — durable lineage, not runtime ownership.
- `origin` (`:112-116`): *"'subagent' … **not proof that the child is continuable**."*
- `delegationDepth` (`:117-122`): *"Persisted so a recursion budget survives restart and resume — a runtime-only depth would reset a resumed child to top-level."* `resolveChildDepth` at `packages/subagent/subagent/src/child-agent.ts:51`; `delegationDepthOf(agent) = Math.max(header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0)` (`depth.ts:28-36`) — header is the monotone floor.
- `agentPreset` (`:123-129`): *"a resume that restored a different composition would replay history the model can no longer act on."*

**This is the seam for the conditional isolated-writer slice (W01–W03):** a child's
workspace identity must be set through `meta.cwd` at creation, never through
`agentOptions` and never by prompting the model to `cd`.

---

## 10. Testkit and test infrastructure (READ)

`packages/test-support/` has **seven** packages: `agent-loop-testkit`,
`llm-mock-server`, `llm-replay`, `session-snapshot`, `client-runtime`,
`remote-mock`, `loader-smoke`.

`@deepseek-ai/dsh-agent-loop-testkit` — `packages/test-support/agent-loop-testkit/`.
Zero `dependencies`; everything is a peer. Two source files.

Exports (`src/index.ts`):
```ts
mountAgentLoopTestDependencies(ctx, options = {}): Promise<void>   // :67-77
mountAgentLoopTestHarness(ctx): Promise<AgentLoopTestHarness>      // :87-93
interface AgentLoopTestHarness {                                   // :28-45
  create(id, options?: AgentOptions, meta?: Pick<SessionHeader,'cwd'>): Promise<Agent>
  claim(agent, target, turn): UserMessage[]
}
interface AgentLoopTestDependenciesOptions { systemPrompt?; tools? } // :48-53
createInboxStub(), unsupportedInbox()                              // :21 re-export
```
`mountAgentLoopTestDependencies` mounts LlmRuntime, SessionStore,
SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry. Doc
(`:55-66`): *"deliberately does not mount AgentLoop **or register an adapter**."*

**No default adapter** — `README.md:75`: *"The harness mounts no LLM adapter.
Register an adapter before sending work that would start a model request."*
Registration: `ctx.llm.registerAdapter(providers: string[], adapter): AdapterRegistrationHandle`
(`packages/llm/llm/src/index.ts:390`); throws `LlmError('DUPLICATE_ADAPTER')` on
conflict.

Canonical mock adapter lives in the loop's own tests, **not** test-support:
`packages/core/agent-loop/tests/mock-adapter.ts` — `MockAdapter` (`:72`) with
`resolveModel`/`stream`, plus `textResponse` (`:5`), `maxTokensResponse` (`:20`),
`toolCallResponse` (`:30`).

`createInboxStub()` (`src/inbox.ts:5-54`) doc verbatim:
> Create a mutable in-memory Inbox stub for tests that exercise only the public
> queue operations. Durable events, projection validation, and live Inbox
> notifications require a real Agent created by the AgentLoop test harness.
> @returns an Inbox backed by **two process-local arrays**.

It never touches a Session. **INV-D3 / gate B10: durability and recovery tests
must use a real Session/Agent.**

`llm-mock-server` is a **wire** fault server (HTTP/SSE), not an adapter. 24
behaviors (`src/index.ts:16-41`) including `rate_limit`, `server_error`,
`stream_disconnect`, `partial_eof`, `max_tokens`. CLI at
`src/cli.ts:37-65`; root script `mock:llm`. **This is the right tool for gate C09
(429) and D07 (request-with-no-result).**

### How tests run (READ)

`vitest.config.ts`: include `packages/*/*/tests/**/*.spec.{ts,tsx}`,
`apps/*/tests/**/*.spec.ts`, `scripts/**/*.spec.ts`, `website/tests/**/*.spec.ts`.
Two projects, both `pool: 'forks'`. All configs use `vite-tsconfig-paths` against
`tsconfig.base.json`, so bare workspace imports resolve to **`src`, never built
`lib/`**.

Single package: `pnpm exec vitest run packages/<group>/<package>/tests/<x>.spec.ts`.

Build step: repo-scripted runs chain `build:native-system` first, but on Windows
that script is a **no-op exit 0** (`native/system/scripts/build.ts:27-30`). The
native addon is consumed only by the JSONL session lease and the Landlock sandbox;
on Windows the lease takes the semaphore branch (`lease.ts:76`), so agent-loop
tests do not need it.

---

## 11. Session durability (READ)

### 11.1 `agent/inbox/spliced`

Payload — `packages/core/agent/src/types.ts:80-95`:
```ts
'agent/inbox/spliced': {
  target: InboxTarget            // 'next-turn' | 'next-step'
  start: number
  removedCount?: number
  inserted: UserMessage[]
  outcome?: 'canceled'
}
```
Recorded by `ReactLoopInbox.mutate` (`packages/core/agent-loop/src/inbox.ts:198-243`,
append at `:235`). `outcome: 'canceled'` only when `discardRemoved && actualDeleteCount > 0`
(`:226`).

### 11.2 Pending inbox has no separate file

It lives in the session event log as `agent/inbox/spliced` events, folded by
`inboxProjectionDefinition` (`inbox.ts:27-65`, registered at
`agent-loop/src/index.ts:417`). A malformed splice throws
`` `invalid persisted inbox splice at session seq ${event.seq}` `` (`:57`).

Restore path: `agent-loop/src/index.ts:898-912` opens for write, cold-reads the
log, appends `interruptedTurnClosers(persisted)`, then
`SessionPreparation.create(...)`. Projections lazily fold the log
(`session-projection/src/index.ts:615-629`). `ReactLoopInbox.current()` reads
`this.projections.stateOf(this.session, 'inbox')` (`inbox.ts:187-195`).

Pinned by test — `packages/core/agent-loop/tests/resume.spec.ts:960-963`:
pending `nextStep` content survives a resume.

### 11.3 Session store is JSONL (READ — premise correction)

`@deepseek-ai/dsh-session-persistence-jsonl`. Config
`{ root: string (required, no default), compression?: 'zstd' | 'none' = 'zstd' }`
(`src/index.ts:96-105`). Shipped `root: dshHomePath('sessions')`
(`packages/bundle/base/cordis.patch.yml:117-120`).

Layout (`README.md:57-68`): `<root>/--<normalized-cwd>--/<encoded-id>/session.v3.jsonl.zstd`
(current generation), with `session.lock`. **Not packed** — packed rows survive
only in the frozen v0/v1 codecs (`README.md:46`,
`session-format-v0-to-v1/src/codec.ts:25`).

Torn tail contract — `session-persistence/src/index.ts:118-123` verbatim:
> events are contiguous from seq 0 and never rewritten; a **torn physical tail is
> never returned to a reader and is truncated by the write path before its first
> append.**

Truncation is **deferred to the first append** (`storage.ts:318-337`), implemented
by `repair()` (`session-persistence-jsonl/src/index.ts:1287-1296`, temp → sync →
truncate). It logs
`` `session "<id>" recovered from a torn tail; incomplete tail bytes were discarded` ``.

Semantic repair is the reader's job — `packages/core/session/src/repair.ts:29`:
`interruptedTurnClosers(events)` emits synthetic `tool/result` errors
(`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`, `:15,18`), closes an open `step/end`
(`:131`), and appends `turn/end { reason: { kind: 'interrupted' } }` (`:133`).
The agent loop **appends** them through the write handle (`agent-loop/src/index.ts:905-907`).

**Gates D09 and D06 map directly onto this**: `TOOL_OUTCOME_UNKNOWN` is the native
vocabulary for "claimed but no confirmed outcome".

`SessionWriteLease` (`lease.ts`) is the only real cross-process lock:
`LEASE_FILENAME = 'session.lock'` (`:40`), flock on POSIX / named semaphore on
Windows (`:76-86`), contention → `SessionAlreadyOwnedError`, and **deliberately no
expiry** (`:10-13`).

### 11.4 session-query (READ — premise correction)

Package default is **`openAt: 'startup'` with a required `path`**
(`session-query-sqlite/src/index.ts:206-224`). Constants: `DEFAULT_LIMIT = 20`,
`MAX_LIMIT = 100`, `SNIPPET_CHARS = 240` (`:79-83`).

**`:memory:` + `openAt: 'never'` is the SHIPPED BUNDLE value, not the package
default** — `packages/bundle/base/cordis.patch.yml:128-140`, restated in
`web-app/cordis.patch.yml:27-30`. The comment says full-text search is opt-in and
`openAt: never` keeps `ctx.sessionQuery` mounted for exact reads/titles/lineage
while search fails with `SESSION_QUERY_SEARCH_DISABLED` (`index.ts:338-344`).

Schema version 8, application id `0x44534851` (`schema.ts:8,11`).

### 11.5 spill (READ)

`ctx.spillStore` — `packages/spill/spill/src/index.ts:45-56`, deliberately minimal:
`saveText(input): Promise<SpillRef>` only; no retention policy, no retrieval API.

Triggered by a `tools/post-execute` listener when flattened text exceeds
`maxInlineBytes` — shipped value **50000**
(`packages/bundle/base/cordis.patch.yml:393-396`). Backend writes
`<root>/session-<sha256(sessionId)[0..12]>/<6-byte-hex>-<encoded-name>`
(`spill-local/src/store.ts:108-131`), `encodeSegment` is injective and defeats
`../`, absolute paths, NUL, separators (`:55-68`). Notice format
(`spill-policy/src/notice.ts:20-22`):
`(N bytes omitted) Full formatted result stored at: <locator>. <retrievalHint>`.

**This is the native mechanism behind "large payloads become artifacts, the record
stores only refs"** — INV-D1 and M4's design.
