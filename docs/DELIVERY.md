# DELIVERY — operations manual

> **Status: nothing in this repository is promoted for daily use.** The promotion
> decision is `NOT_READY` (`qualification/gates-summary.json`). This manual
> describes how the current, unpromoted build is installed, started, stopped and
> recovered — and, in §5 and §9, what it explicitly does **not** guarantee.
>
> Commands marked **VERIFIED** were run on this machine and their output is under
> `qualification/results/`. Everything else is a procedure that has not been
> executed end to end, and is marked as such.

## 1. Identity

| Item | Value |
|---|---|
| Upstream | `deepseek-ai/deepseek-harness` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`) |
| Upstream checkout | `D:\DSH\src\dsh-src` (disposable) |
| This repo | `D:\DSH\work\dsh-native-daily`, branch `ipython-native` |
| Built launcher (**the qualified one**) | `node apps/cli/lib/bin.js`, sha256 `69c49c871735dc7ee81ec51f266bbec129f075fd5066e046374f4b13ab02a705` |
| Source launcher (**not interchangeable**) | `pnpm dsh` = `node --import tsx/esm apps/cli/src/bin.ts` |
| Pinned pnpm shim | `D:\DSH\tools\bin\pnpm` (11.7.0 via corepack) |
| Node | `^22.19.0 \|\| >=24.0.0`; this machine v24.18.0 |
| Canary homes | `D:\DSH\home\canary` … `canary5` |
| Daily home | **not created.** Nothing is promoted. |

The two launchers are **different distribution identities**. VERIFIED: with an
overlay that inserts a plugin by path, the built launcher completes the tool round
trip while the source launcher dies with
`Cannot read properties of undefined (reading 'prepare')`. Reproduced 3/3.
Evidence: `qualification/results/M0.6-launcher-identity/`.

`compatibility.lock.json` carries the deployment identity
(`73da4c62…`, a sha256 over the artifact, lockfile, profile patch, preset,
resolved graph and acceptance spec). **Any change to any of those inputs changes
the identity and invalidates every PASS recorded against the old one.** That is
intended, not a bug.

> **The identity was re-derived once, and it had already gone stale before that.**
> The previous value was `0ca14d4e…`. Two inputs had moved away from it:
> `acceptance_spec_sha256` (the 112-case spec was installed, changing the digest)
> and `launcher_realpath`, which had been written through Python escape
> processing — `\apps\` became BEL (`0x07`) and `\bin.js` became backspace
> (`0x08`), so the field read `dsh-src\u0007pps\cli\lib\bin.js`. The **mangled**
> value is what the old hash was computed over, so `0ca14d4e…` described a path
> that does not exist. Both are corrected and the identity recomputed; the 85
> PASS rows in `qualification/gates.json` were regenerated against it. Recorded
> as G-FIX-11. This is exactly the invalidation the paragraph above promises, so
> it is the mechanism working, not a regression.

## 2. Install

**VERIFIED.**

```sh
cd /d/DSH/src/dsh-src
corepack prepare pnpm@11.7.0 --activate
corepack pnpm install --frozen-lockfile --network-concurrency 4 \
  --fetch-retries 5 --fetch-retry-maxtimeout 120000
```

**Trap 1 — the network.** The first attempt failed with `TypeError: fetch failed`
after 1285 of 1319 packages. Registry throughput here is 2–35 KiB/s. Lowering
concurrency and raising retries succeeded in 19m13s. This is a slow-network
problem, not a resolution problem; do not "fix" it by relaxing the lockfile.

### Build — VERIFIED

```sh
export PATH="/d/DSH/tools/bin:$PATH"   # the pinned pnpm shim
cd /d/DSH/src/dsh-src
pnpm build
```

**Trap 2 — the nested pnpm.** The build script spawns a bare `pnpm` from PATH.
That resolved to the **global** pnpm 11.24.0, which refused because the repo
declares `packageManager: pnpm@11.7.0`. Corepack does not switch versions once
invoked. The fix is the shim directory above. The global pnpm was not modified.

### The extension package

```sh
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
powershell -NoProfile -ExecutionPolicy Bypass -File link-all-dsh.ps1
```

`link-all-dsh.ps1` junctions the pinned DSH packages into the extension's
`node_modules` so it compiles against **real** DSH type declarations, deriving the
junction set from the checkout rather than maintaining it by hand. It is a
development convenience for this machine's layout, not part of the deliverable.
(`link-dsh.cmd` is the older hand-maintained variant; `link-all-dsh.ps1` is the
one to use, because it derives the set rather than listing it.)

**Trap 3 — a moved install breaks every junction.** `D:\DSH` was renamed and moved
back once, and because junction targets are stored as absolute paths, every
`node_modules/@deepseek-ai/*` link pointed at a non-existent directory during the
move. Re-run the script after any move of the install root.

### Install the extension into a profile — VERIFIED

Both extension packages are installed into a profile as **bundles**, which is what
makes their host-plane rows activate. The profile manifest carries the two
dependencies and names them in `dsh.profile.bundles`:

```jsonc
// profiles/daily-candidate/package.json
"dependencies": {
  "dsh-daily-work": "link:D:/DSH/work/dsh-native-daily/packages/dsh-daily-work",
  "dsh-ipython":    "link:D:/DSH/work/dsh-native-daily/packages/dsh-ipython"
},
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "dsh-daily-work", "dsh-ipython"
] } }
```

```sh
export PATH="/d/DSH/tools/bin:$PATH"
export DSH_HOME='D:\DSH\home\<your-home>'
mkdir -p "$DSH_HOME/profiles"
cp -r /d/DSH/work/dsh-native-daily/profiles/daily-candidate "$DSH_HOME/profiles/daily"
cd "$DSH_HOME/profiles/daily"
node /d/DSH/src/dsh-src/apps/cli/lib/bin.js plugin --profile daily install
node /d/DSH/src/dsh-src/apps/cli/lib/bin.js --profile daily --dump-config | grep -A2 'agent-presets'
```

The install directory name (`daily` above) is **chosen by the operator** and is
not referenced anywhere in the profile. That is deliberate — see Trap 6.

**Trap 5 — a `link:` dependency must be absolute, or the profile is not
relocatable.** `link:../../packages/x` is resolved against the **installed**
profile directory, not the repository, so it points at a path that does not exist
once the profile is copied into `$DSH_HOME`. Both dependencies therefore carry an
absolute `link:`. Measured: with the relative form the install reported success
and `--dump-config` then failed with
`cannot resolve profile bundle "dsh-daily-work"`.

**Trap 6 — the agent-preset root must not be relative, and must not name the
install directory.** The `agent-presets` row adds a `roots` entry pointing at the
profile's own `presets/` directory, which is where the two agent-scoped tool rows
live (`work` and `ipython`). Two forms that look correct both fail:

| Form | Why it fails |
|---|---|
| `./presets` | `scanRoot` does `resolve(expandHomePath(root.path))` (`packages/preset/agent-presets/src/discovery.ts:285`), and Node's `resolve` is relative to the **process cwd**. Booting from the profile directory worked; booting the same installed profile from elsewhere gave `RemoteError: preset "daily-standard" not found` with **zero** tools. |
| `process.env.DSH_HOME + '/profiles/daily-candidate/presets'` | Absolute and cwd-independent, but it **hardcodes the install name**, which the operator chooses. Installed as `daily` it resolved nothing. |

The working form derives the path from `ctx.baseUrl`, which the launcher anchors
at the profile's own directory (`apps/cli/src/profile-boot.ts:160-164`). **The
`.replace()` is load-bearing on Windows and a no-op on POSIX:**

```yaml
- id: agent-presets
  config:
    default: daily-standard
    roots:
      - path: !!js new URL('presets/', ctx.baseUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1')
        trust: system
    includeShippedRoot: true
    includeUserRoot: true
```

**Trap 6b — a `URL.pathname` on Windows starts with a slash, and `resolve()`
then makes the path meaningless.** `new URL('presets/', 'file:///D:/x/cordis.yml').pathname`
is `"/D:/x/presets/"`. Node's `resolve` does **not** treat a leading slash before
a drive letter as a drive-absolute path; it treats it as rooted on the **current
drive**, so from a cwd on `E:` the result is `E:\D:\x\presets` — a path that
cannot exist. The failure is silent in the worst way: the directory is simply
absent, `scanRoot` returns no presets, and the roster reports
`preset "daily-standard" not found` with **zero** tools. The fix is the
drive-letter strip above. This was measured in both directions — with the strip,
`presetsListed: standard, ptc, minimal, cordis, daily-standard` and
`toolCountAgentKey: 28`; without it, `daily-standard` is absent and the count is 0.

Both the working and the failing direction are recorded in
`qualification/results/M12-deliverable-surface/`.

**Trap 7 — a tool row belongs in the AGENT preset, not in the profile patch.**
`ctx.tools` layers are keyed by the Agent object, so a tool row mounted at host
level publishes into the root realm where no agent's scope sees it: the model gets
the service and no way to call it, with no warning. This is why the two model-facing
rows live in `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
while the host-plane services come from each package's own bundle patch.

**Trap 8 — do not declare a row twice.** The profile patch and
`dsh-daily-work`'s own bundle patch both used to insert `daily-work-host`, so
installing the package as a bundle would have registered the service twice. The
bundle is now the sole owner; the profile patch keeps only the `subagent` capacity
override and the `agent-presets` row.

### Verify the install reached the model — VERIFIED

A boot probe that adds **no** rows of its own, so whatever it reports comes from
the profile's own composition:

```sh
cd /d/DSH/home/<your-home>/profiles/daily
node /d/DSH/src/dsh-src/apps/cli/lib/bin.js --profile daily \
  --patch 'D:\DSH\work\dsh-native-daily\qualification\runners\verify-deliverable-surface.patch.yml' \
  --no-open
# then read qualification/results/M12-deliverable-surface/surface.json
```

Measured on this machine: `toolCountAgentKey: 28`, `ipythonToolPresent: true`,
`workToolPresent: true`, `ipythonParameterNames: ["code"]`,
`forbiddenLifecycleTools: []`. `toolCountContextKey` is recorded alongside as `0`,
which is the contrast that shows the agent-keyed scope is the one that matters.

**Trap 4 — the build and the typecheck are different configs.**

```sh
tsc -p tsconfig.json        --noEmit   # WRONG for gate evidence: EXCLUDES src/**/*.test.ts
tsc -p tsconfig.check.json  --noEmit   # the one to cite: identical strict flags, exclude cleared
```

`tsconfig.json` excludes test files so the build never emits them into `lib/`.
That exclusion is correct for the build and makes `tsc -p tsconfig.json --noEmit`
exit 0 **with or without** a test file present — a false pass. This was caught and
recorded in `qualification/results/M9.2-terminal-advanced/FINDINGS.md`; the
corrected config immediately surfaced two real type errors the old one hid.

**Test count: 592 collected across 37 files**, measured with `vitest list` at
commit `2d4534f`. That is a **collection** count, not a passing count: no
full-suite pass/fail run is recorded in this repository. The figure cannot be
re-verified at an arbitrary later commit, because the package is under active
concurrent edit and a mid-edit tree does not parse.

## 3. Doctor

```sh
python <delivery-package>/helpers/doctor.py --source /d/DSH/src/dsh-src
python qualification/runners/build-gates.py
```

The doctor is a **read-only metadata check**, not a DSH qualification. The gate
generator derives `qualification/gates.json` from evidence on disk and refuses to
emit a PASS with no evidence file present.

## 4. Start, pause, recover, shutdown

### Start — VERIFIED for headless only

```sh
export PATH="/d/DSH/tools/bin:$PATH"
export DSH_HOME='D:\DSH\home\canary'
cd /d/DSH/src/dsh-src
node apps/cli/lib/bin.js --profile headless --patch <overlay.patch.yml> "task text"
```

VERIFIED: a keyless overlay driven by the in-tree mock adapter produces
`CLI tool round trip complete: CLI_TOOL_ROUND_TRIP` on stdout, reasoning on
stderr, and a persisted zstd JSONL Session with no torn tail.

**The daily driver is intended to be a long-lived Web host**, because headless
exits after one task and must not be wrapped in a shell loop to fake a second
model loop. **That host has not been qualified on this machine** — gate `A12` is
`NOT_RUN`. Its recorded partial result: the real launcher bound a real port, the
fence returned 401 unauthenticated, the token URL → cookie → 200 app shell worked,
`session/create` + `session/list` round-tripped, and the booted graph carried both
C2 changes. **No model turn ran**, because `DEEPSEEK_API_KEY` is absent from every
source the credentials provider layers; the SDK profile was used to confirm the
boundary is CREDENTIAL and not composition (it booted, reached `turn/start` with a
real tool catalog, then stopped at `MISSING_CREDENTIAL`). No clean-shutdown claim
is made: on win32 `child.kill` terminates rather than delivering a signal.

Inspect the resolved configuration — **VERIFIED**:

```sh
node apps/cli/lib/bin.js --profile <name> --dump-default-config   # bundles only (the STOCK baseline)
node apps/cli/lib/bin.js --profile <name> --dump-config           # + profile + home + patches
```

`--dump-default-config` deliberately omits the profile's own patch layer, which is
why it is the right tool for measuring stock.

**Trap 5 — a malformed patch is rejected, not ignored.** A stray literal `[]`
after comment blocks produced `failed to parse overlay …: YAMLException`. The
loader fails loudly, which is the behaviour you want.

**Trap 6 — a patch replaces the whole `config` object.** It is not a deep merge.
Restate every key you need, or the others silently revert to schema defaults. This
is why `cordis.patch.yml` restates both `maxActiveSubagents` and `maxDepth`.

### The N control

N is `targetActiveChildren`, an integer **1..30**, set by the user through
authenticated control and persisted in the run record (`requestedTarget`). It is
not the model's to change: the `work` tool can `submit`, `status` and `finish`, and
cannot reach the target, the budget ceiling or the permission ceiling. A tool that
let the model edit its own resource ceiling would not be a resource ceiling.

What N means, precisely:

- **N counts children, not the root.** The root is partitioned out of the count
  and keeps its own reserved inference credit (`rootReserve`, default one tenth of
  the ceiling floored at 1 and capped at 20 units), so it can always integrate
  results and submit replacements.
- **The ceiling is a deployment cap, not a per-run wish.** `maxActiveSubagents` is
  **per-family, not host-wide** — measured: two roots each get a full pool. So N is
  a per-run target, and there is no host-wide 30 enforcement today.
- **Occupancy is `reserved + starting + active_assignment + stopping + unknown_quarantined`.**
  A child waiting on its own tool still holds its slot. An idle historical Session
  does not. A parked kernel does not hold a child slot (it holds memory).
- **The counts are reported separately and never merged into one green number**:
  `desired_target · ready_tasks · durably_admitted · launching ·
  active_assignments · waiting_owned_tool · provider_waiting · stopping ·
  quarantined_unknown · completed · capacity_deficit(+reason)`.
- **Lowering N stops new admission and lets running tasks converge.** It does not
  silently kill anything. Raising N still requires budget and the global cap.
- **Pause is a separate state from N.** Pause is a record change plus a refusal to
  admit; it never rewrites N to 0, and it does not drain — using
  `drainContinuableDescendants` for a pause would close admission for that parent
  permanently and make a later resume impossible.

### Pause and resume

```ts
await service.pause(runId, reason)   // phase open -> paused; a pending outbox entry records why
await service.resume(runId)          // phase paused -> open; a new authorization edge, never implicit
```

**VERIFIED at the mechanism level** (`scheduling.test.ts`, `u03-sustained-load.test.ts`):
pause refuses admission, resume restores it, alternating across six waves, with
resources and listeners flat (drift 0). A user pause outranks top-up.

### Recover

The system recovers three separate objects and does not conflate them:

1. **Durable Session / Inbox and admission** — DSH's own recovery, reused.
2. **Checkpointed data and code files** — load only after verifying hash, schema
   and environment.
3. **Volatile kernel** — **a new epoch by default. Past cells are not replayed.**

**VERIFIED:** a real forked Node process admits work into a real storage domain,
is killed with `SIGKILL`, and the same directory is reopened from a fresh process.
The record, every task state and the exact reservation were recovered, and
reconciliation returned `unknown` rather than relaunching anything. 4 consecutive
runs, `childExitSignal: SIGKILL`, all six checks true
(`qualification/results/M4.1-process-kill/`).

Recovery rules that are load-bearing:

- **Never auto-replay.** An interrupted turn, a lost reply and a disposal error are
  reasons to look, not permissions to retry. `reconcileTask` returns `unknown` when
  the evidence does not settle the question, and a reserved id with no trace is
  quarantined rather than relaunched.
- **A lost parent notification is not a child failure.** If the child's Session
  shows the work completed, the work completed.
- **A run without restart authorization comes back PAUSED.** It does not
  automatically re-consume budget or produce effects.
- **No automatic `dill.load`/pickle deserialization** of an untrusted cross-epoch
  snapshot.

### Shutdown

Stop means: **refuse new admissions → stop owned work → release storage → unwind
the context.** This order was measured, and the naive order deadlocks — a child
parked in a model call cannot be torn down while context disposal waits for its
driver to exit. A user Stop outranks top-up, and nothing in this project revives a
stopped run.

## 5. Kernel state loss — what is volatile, what survives, what is NOT recovered

**There is no IPython kernel in this product yet.** `grep` over the package's
non-test sources finds no `ipykernel`, `jupyter_client` or `python_exec`. What
follows is the contract the architecture requires, plus the mechanism findings
that are already measured; the volatile-state table is a **specification**, and
the kernel-state-loss recovery path is **NOT_RUN**.

### Volatile — lost on any kernel restart, reset or epoch change

| Object | Survives? |
|---|---|
| Python variables, functions, DataFrames, temp indexes | **No** |
| Imported modules and their in-memory state | **No** |
| Open file handles, threads, async tasks | **No** |
| `%history`, `In`/`Out` | **No** (unless checkpointed) |

Measured in the probe tier (`M10.0-audit-repro/ipython-local.json`):
`kernel_restart_loses_volatile_state` — PASS as a mechanism probe.
`exception_does_not_roll_back_namespace` — an exception leaves earlier assignments
in place, so **a kernel error is not a transaction rollback**. After an interrupt
the kernel is reusable, but a `KeyboardInterrupt` is also not a rollback.

### Survives

| Object | Where |
|---|---|
| Session events, Inbox, requests, recovery events | DSH Session log (zstd JSONL, no torn tail measured) |
| Artifacts and captured bytes | artifact store / spill store, keyed by content hash |
| The run record: assignment, budget, outbox, tombstones | `dsh_daily_work` domain |
| Explicitly checkpointed data (JSON, NPY/NPZ non-object, Parquet/Arrow) | the checkpoint, after hash/schema/environment verification |

### Explicitly NOT recovered

- **The last cells' effects.** An in-flight cell or tool with no confirmed terminal
  state is `unknown`, not replayed. Disk state, kernel memory and remote service
  state do not roll back each other.
- **A checkpoint that is behind the last cell is not "fully recovered".** Every
  recovery must report `as-of`, `loaded`, `skipped`, `lost`, `environment changed`
  and `unresolved effects`. A rebuilt array may lag the last cell, and reporting
  only "recovery succeeded" would hide that.
- **The audit's own finding on interrupts, which constrains the design.**
  Interrupting a cell suspended in `await` did **not** settle: `settled: false`
  after 20.15 s, a second interrupt also `false` after a further 10.07 s, kernel
  process still alive — while a CPU loop interrupts in 1.8 s
  (`qualification/results/M11-ipython/cases.json`). A design that waits for a
  reply after an interrupt can hang a model turn indefinitely. The required
  behaviour is: **bounded grace, then report `unknown` and restart the kernel.**
- **Cell boundaries are not a security boundary.** Background threads and old
  tasks in the same CPython process can touch a later cell's memory. Authorization
  is per Session/kernel; a permission-domain or project change requires a kernel
  restart, and updating a token alone is not isolation.

## 6. Artifact retention and deletion

**This section describes what exists today, which is upstream behaviour this
project has not replaced.**

### What happens now

Oversized plain-text tool results are spilled by `@deepseek-ai/dsh-spill-policy`
when the flattened text exceeds `maxInlineBytes: 50000`
(`packages/bundle/base/cordis.patch.yml:393-396`). The shipped `spill-local`
backend is mounted with **no `root` config**, so the destination is its private
per-process default: `mkdtempSync(join(tmpdir(), 'dsh-spill-'))`
(`packages/spill/spill-local/src/store.ts:36-38`).

Three properties a reader must not assume away:

- **The locator given to the model is an absolute filesystem path**, and the
  retrieval hint is verbatim
  `'Use read with offset/limit, or grep this path to search within it.'`
  (`spill-local/src/index.ts:156,159`). So the model is told to read a host path
  directly. That is exactly the pattern the architecture requires replacing with an
  authorized data API; **the replacement does not exist yet**.
- **Spill is not a retention contract.** `saveText` persists text and returns an
  opaque locator. It provides no unified read/delete/permission/reference-counting
  contract, and saving an already-clipped text does not make it the original.
- **The root is a temp directory.** Cleanup sweeps discovered prior-default
  `dsh-spill-*` roots by age (`spill-local/src/cleanup.ts`). So spilled artifacts
  are **not durable storage** and must not be cited as the original of anything.

### The contract the architecture requires (NOT_RUN)

Commit order, so a crash cannot produce a false claim:

1. verify permission and allocate the host observation identity;
2. stream to a temporary object, computing size and hash per chunk;
3. flush/fsync and atomically publish;
4. record the reference/coverage in the Session and checkpoint;
5. only then return a `durable=true` reference.

- Object published but event not committed → **orphan**, not a delivered
  observation; a recovery scan and a grace-period GC handle it.
- Event committed but object missing → **integrity error / unavailable**. Never
  return an empty string.
- Effect happened but the save failed → the effect is `unknown`/already happened.
  **Do not re-execute to "fix the log".**
- GC only reclaims objects that are unreferenced, unleased, unpinned and past the
  grace period. Artifacts a user expects to be kept are not silently deleted on a
  schedule. Deletion leaves a tombstone, and reading a deleted reference returns an
  explicit expired/deleted rather than nothing.
- Backup must include the objects **and** the information to rebuild the index.

## 7. Permissions — and what is NOT guaranteed

**Read this section before trusting any confinement claim.**

The formal production path is: trusted DSH host + first-party SSH execution world
+ a dedicated Linux execution VM. This machine is **Windows, which is not that
path**, and the measurements below are why the Windows host is not claimed as a
confinement boundary.

### Guaranteed on this machine

- **Writes outside the workspace are denied.** Measured under both `read-only` and
  `workspace-write`: `EPERM`.
- **The terminal refuses a mode change while a PTY is live**, and the refusal is
  total: zero sandbox/mode events logged **and** `resolve()` still reports the old
  mode. Owner-scoped. (`E03` PASS.)
- **`tool-plugin-manager` is disabled** in the shipped standard preset and demands
  `danger-full-access` when enabled. This project does not enable it. (`E04` PASS.)
- **`ctx.terminalController` is not wrapped as a model tool.** Its own source says
  it runs with "the execution environment's system-user permissions" and spawns
  with no sandbox wrap; wrapping it would be privilege escalation, not
  convenience. (`E02` PASS on the catalog half.)

### NOT guaranteed — measured FAILs, not hypotheses

- **The Windows sandbox is a WRITE boundary, not a read boundary.** `E01` is an
  honest **FAIL**: a confined child **read** a canary secret outside the workspace
  root verbatim, exit 0, under **both** `read-only` and `workspace-write`.
  `WRITE_RESTRICTED` intersects only write accesses, enforcement is literally
  `'partial'`, and `SandboxPolicy` carries only `mode` + `workspaceRoot` — **the
  seam has no read lever even in principle.** The only credential control anywhere
  is `scrubbedParentEnv()` in `@deepseek-ai/dsh-subprocess`, a **name heuristic**
  (drops `/KEY|PASSWORD|SECRET|TOKEN/i` and `DSH_*`) that is defeated by a
  credential in a file and by an explicit env entry by design.
- **Egress is not controlled.** `E06` is an honest **FAIL**: a confined child
  completed a real HTTP round trip to a loopback server and connected to a public
  address, under both modes. `web_fetch`'s SSRF guard is real and was exercised
  (`127.0.0.1`, `::1`, `169.254.169.254`, `10.0.0.1` all refused; `WEB_BLOCKED_URL`;
  pinned lookup) — but it filters **that tool's URL only**, has no relation to
  `ctx.sandbox`, and is **bypassed by any shell command**. The seam README says
  file effects are the whole vocabulary, which is now executable evidence rather
  than a doc claim.
- **Signal-based interruption does not work under confinement.** Measured: under
  `workspace-write`, `terminals.signal(owner, id, 'SIGINT')` returns
  `{delivered: true}` in ~17 ms and the command **keeps running to completion**
  (5/5 trials; the token appears at 20.1 s for a 20 s sleep). `SIGTERM` is the
  same. Mechanism: on Windows the interrupt is delivered as a `\x03` input write
  that conhost turns into a console-wide Ctrl-C, which reaches the ACL **runner's**
  console, not powershell's foreground process. **A caller that treats
  `delivered: true` as "the interrupt landed" will believe it stopped a cell that
  is still running and still able to write inside the workspace.** The mitigation,
  also measured: `terminals.kill()` **does** stop the cell under confinement — at
  the cost of the session state the persistent PTY existed to provide.
- **Terminal framing is forgeable, and the cost is quantified.** A send result
  carries an identical field list for success and failure
  (`viewport | waitReason | sessionStatus | truncated`) with **no verdict field**,
  so failure is visible only as text. A forged OSC `133;D;0` marker settles the
  send in **138–185 ms** versus **3025–3135 ms** for the same command answered
  honestly, while the cell is still sleeping. Framing is a convenience, not an
  integrity mechanism.
- **`localhost` is an address, not a permission system.** The Web host publishes
  `DSH_WEB_URL` into every model shell's environment. The launch token is **not**
  in that environment (`tokenExposure.launchTokenIsInShellEnv: false`, overlay
  `[DSH_HOME, DSH_SHELL, DSH_WEB_URL]`), the index route returned **401**
  unauthenticated, and `/api` returned **403** for a hostile `Host` header — but
  the index route is **auth-fenced, not Host-fenced**, so the rebinding defence is
  an `/api` property and not a server-wide one.
- **The deployment boundary is the only protection against a second host, unless
  `homeLockPath` is configured — and it is not configured by default.** Measured:
  a real second Node process opens the same live store with **no error**, its write
  lands durably, and then the first host's next publish **erases it**. The kernel
  lock that fixes this exists (`src/homelock.ts`) and is proven when configured,
  but no shipped profile sets `homeLockPath`.
- **A caller-supplied `maxDepth` lifts the deployment depth cap, and an omitted one
  is not a refusal.** `resolveChildDepth` treats the request value as an absolute
  cap, so a larger number admits deeper delegation, and an omitted `maxDepth`
  behaves the same as `99`. This project's own path is unaffected (`launch-port.ts`
  hard-codes the deployment value), but **the workflow/PTC path is not covered**:
  `packages/workflow/workflow-ptc/src/host.ts` calls `subagents.start()` with no
  `maxDepth`.
- **The Windows sandbox is not the production path.** A design that relies on
  confinement on this host is relying on a write-only boundary with uncontrolled
  egress.

## 8. Known limits

1. **No reachable IPython.** The model's execution surface is still `pwsh`
   (measured catalog: 27 tools including `pwsh`; no `python_exec`). A
   `packages/dsh-ipython/` package has started as untracked work (`src/protocol.ts`,
   `src/broker.py`) but has **no `package.json`, no `lib/`, no `cordis.patch.yml`
   and no test**, so no profile can load it. See `docs/DELETE-AUDIT.md` §3.6.
2. **The production launch port was missing until `2d4534f`.** Before that commit
   `WorkService.setLaunchPort` had zero production callers, so a model `submit` on
   the composed profile recorded a task, marked it `unknown` with
   `no launch port installed`, and launched nothing. The N=10 suite could not see
   it because it installs its own port. `createRun` now calls
   `installDefaultLaunchPort(root)`, the bundle patch names
   `subagentProvider: spawn`, and `production-port.test.ts` (`b8f1ef2`) installs
   **nothing** and asserts the drain reaches the real `startContinuable` seam.
   **Established at the test tier, not the boot tier** — the N=10 evidence predates
   the change and no gate report has been regenerated.
3. **The Goal handover was wired at `982e82b`.** Before that commit
   `takeContinuation` had zero production callers, so a managed run never disarmed
   the Goal round-driver and two continuation owners could drive one root. It is
   now taken at `createRun` and the result is stored on the run record (optional
   `continuation` field). **Code and test tier, not boot tier.** Nothing *reads*
   `.continuation` yet, so the field records the handover rather than checking it.
4. **The run record's `epoch` field is inert in the product.** The guard that would
   enforce it (`applyWorkerSettlement` in `recovery.ts`) is real and tested, but
   `recovery.ts` is **not reachable from any production path** — zero non-test
   importers, outside the closure of every `package.json` export, and zero callers
   outside its own module and its test. Nothing bumps `epoch` either. What is
   enforced is object identity (`tool-protocol-guards.ts`), which covers the
   in-process resume case. A run re-adopted across a **process** boundary has no
   epoch enforcement today. See `docs/DELETE-AUDIT.md` §3.8.1.
5. **No live paid run.** `C01` is `BLOCKED_EXTERNAL`:
   `live_provider_budget_authorized: false`. A key being present would not
   authorize large paid evaluation.
6. **No host-wide 30.** `maxActiveSubagents` is per-family; two roots each get a
   full pool. Measured, and recorded as G-SEAM-19.
7. **A preset is not self-contained.** Two presets sharing one composition file
   share one ESM module instance. Registrations are per-Session and tool catalogs
   stay separate, but module-scope state does not. This is why `src/tools.ts` holds
   no cross-session state — a measured constraint, not a style preference.
8. **`ctx.terminals.spawn()` does not resolve under `read-only` sandbox mode on
   Windows.** It resolves under `workspace-write` (~0.8–1.2 s) and
   `danger-full-access` (~740 ms). An earlier version of the README said
   "confined" generally; that was a measurement error from probing a single mode.
9. **No real coding or research task has run** under a frozen configuration, so
   there is no end-to-end quality claim.
10. **The kernel transport has a platform constraint.** The architecture lists IPC
    first; on Windows `transport='ipc'` fails at socket creation
    (`ZMQError: Protocol not supported`) because libzmq is built without IPC
    support. The usable encrypted path is `transport_encryption='required'`, which
    yields CurveZMQ keys and removes the plaintext warning the default path emits.
11. **Two classes of cell do not settle after an interrupt, and the kernel is left
    dirty.** Await-suspended: not settled after 20.15 s, second interrupt also not
    settled after a further 10.07 s, process alive. Non-interruptible C code
    (`re.match(r'(a+)+$', …)`): timed out after 12.16 s with the interrupt
    delivered in 0.002 s. The CPU-loop case interrupts in 1.1–1.8 s. Worse: after
    a wedge the kernel carries a **pending interrupt that aborts the NEXT cell**
    (`status: 'aborted'`, `executionCount: null`, no output), and the cell after
    that runs normally — so continuing without a restart silently corrupts the next
    result. Evidence: `qualification/results/M5-lifecycle/PROBE-FACTS.md` facts
    8–10, `qualification/results/M11-ipython/cases.json`.
12. **A cell id is not an isolation boundary, measured.** A background thread left
    by one cell mutated shared state that a later cell then printed. A cell id is
    an attribution/cancel/audit key only. Evidence: `M5-lifecycle/PROBE-FACTS.md`
    fact 16.

## 9. How to read the gate report, and what NOT_READY means

`qualification/gates.json` is a **bare array** (the delivery package's checker
requires that shape). `qualification/gates-summary.json` carries the counts and the
promotion decision.

```sh
python qualification/runners/build-gates.py     # regenerate from evidence on disk
```

The generator refuses to emit a PASS with no evidence file present. It maps
`PARTIAL` to `NOT_RUN` — **there is no PARTIAL status**, so a partial result is
reported as not run rather than as a soft pass.

Status vocabulary, and what each one authorizes you to believe:

| Status | Means |
|---|---|
| `PASS` | A test or a real command ran and passed, with at least one evidence file whose sha256 is recorded. |
| `FAIL` | Measured, and the measurement contradicts the requirement. |
| `NOT_RUN` | Not exercised. **Includes `PARTIAL`.** Not a soft pass. |
| `BLOCKED_EXTERNAL` | The remaining work needs an authorization this machine does not have. |
| `NOT_APPLICABLE` | A conditional capability that is deliberately not enabled. |

### The promotion rule

> **READY only if all mandatory gates pass. `NOT_RUN` / `FAIL` /
> `BLOCKED_EXTERNAL` do not equal done.**

Current state (`qualification/gates.json`, 104 cases of which 88 are mandatory):

```
PASS 85 (75 mandatory) · NOT_RUN 10 (all mandatory) · FAIL 2 (both mandatory)
BLOCKED_EXTERNAL 1 (mandatory) · NOT_APPLICABLE 6 (all conditional)
promotion_decision: NOT_READY
```

**`NOT_READY` means the system is not certified for daily use, and the report says
so in its own vocabulary rather than in a footnote.** It does not mean the
mechanisms are unproven — 85 gates pass, and several of them are load-bearing
(ten children admitted through the real `startContinuable` seam; a run surviving a
real `SIGKILL`; an A→B→A mutation caught by an immutable snapshot). It means the
mandatory set is not closed.

Three specific things `NOT_READY` covers that a reader might otherwise miss:

- **Two mandatory gates are honest FAILs, not gaps.** E01 and E06 were measured and
  the measurement contradicts the requirement. Re-reading them as "not yet
  verified" would understate them.
- **One mandatory gate is blocked on a decision, not on work.** C01 needs an
  authorized budget.
- **The old report's numbers do not carry over.** Its 104 cases share **zero** ids
  with the new 112-case spec, and its evidence hashes are already partly stale
  (3 of 127 references no longer match the file on disk). See
  `docs/DELETE-AUDIT.md` §4.

## 10. Upgrade procedure

1. **Diff API, exports and tests** between the pinned commit and the candidate —
   before installing anything.
2. Test in an **independent canary home using a state copy**. Never test an upgrade
   against the daily home.
3. **Cold backup**, or the official consistency export. Never copy a live database
   and call it a consistent snapshot.
4. **Immutable version directory, new process.** HMR is not a restart qualification.
5. **Small upstream delta, canary first, promote second.** A live provider is
   required for the paid half and is `BLOCKED_EXTERNAL`.

Any change to the artifact, lockfile, profile patch, preset, resolved graph or
acceptance spec **changes the deployment identity** and invalidates every PASS
recorded against the old one.

Record the public patch queue across DSH versions, and on upgrade run the stock and
new-seam regressions **before** promotion.

## 11. Backup

**In the backup:**

| Object | Where |
|---|---|
| Session log (durable facts: what happened, calls, results, Inbox, requests, recovery events) | `DSH_HOME/sessions/` (zstd JSONL) |
| Artifacts and captured bytes, keyed by content hash | artifact store; **note §6: today's spilled text lands in a temp root and is NOT durable** |
| Configuration | `DSH_HOME/profiles/`, `DSH_HOME/.agent-presets/`, `compatibility.lock.json` |
| The run record | the `dsh_daily_work` domain inside the storage backend |
| Index rebuild information | the index is derived and must be rebuildable from the canonical Session/artifact; a backup that carries the index but not the canonical store is not a backup |

**NOT in the backup, and must not be claimed as recovered:**

- **Volatile kernel state.** Variables, functions, open handles, threads, async
  tasks. There is no kernel yet, and when there is, its memory will not be in the
  backup.
- **In-flight external effects.** An operation that may have committed remotely is
  not withdrawn by restoring a backup. After a state rewind, reconciliation
  **cannot be driven from the local ledger at all** — the effect record lives in
  the state that was just rewound, and the domain then refuses to open
  (`DomainError: … stored record … does not match its schema`). It has to be driven
  from the **remote**, by operation id. Measured:
  `qualification/results/M9.20-real-tasks/u06-rollback.mjs` step R8a.
- **Parked kernel memory.** Not a child slot, but real RSS; a backup does not carry
  it.

**Backup consistency.** Take it while quiescent, or use the official consistency
export. Verify a restore by **tree digest**, not by presence.

## 12. Rollback

1. Restore the old artifact **and** the old state snapshot the new version has not
   migrated. Both, or neither.
2. **Reconcile external effects the new version already produced.** Rolling back
   software does not withdraw a remote action. Expect the local ledger to be
   unusable after the rewind (§11) and reconcile from the remote.
3. A schema that cannot be migrated safely **refuses to start** rather than
   silently reading a backup. That refusal is correct; plan for it rather than
   working around it.

VERIFIED as a rehearsal, over a temp home:
`qualification/results/M9.20-real-tasks/u06-rollback.mjs` — old artifact + old
consistency snapshot restored byte-for-byte (tree digest equal), the external
effect reconciled and **still present in the world**, and the transport invoked
**zero additional times**. No real newer version was installed; the "new version"
is the same built artifact with a bumped version string, and no real remote was
contacted. The rehearsal is about the procedure, and the report says so in its own
`notExercised` field.

## 13. Evidence layout

```
qualification/results/<slice>/
  FINDINGS.md / <slice>-notes.md   what was measured, and what was not
  tests.txt                        real runner output
  tsc.txt                          real type-check output (tsconfig.check.json)
  source-digests.txt               sha256 of the sources that produced the result
  report*.json                     machine-checkable results where applicable
```

Sensitive full logs stay in a protected location; the redacted summaries are what
gets shared.
