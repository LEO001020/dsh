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
(`549732b5…`, a sha256 over the artifact, lockfile, profile patch, preset,
resolved graph and acceptance spec). **Any change to any of those inputs changes
the identity and invalidates every PASS recorded against the old one.** That is
intended, not a bug. The value is not typed by hand anywhere it matters:
`qualification/runners/build-gates.py` reads it out of the lock, so
`qualification/gates.json` and `qualification/gates-summary.json` cannot disagree
with it. VERIFIED: re-deriving it from `deployment.inputs` with
`sha256(json.dumps(inputs, sort_keys=True, separators=(',',':'), ensure_ascii=True))`
reproduces `549732b5…` exactly, and
`qualification/results/T1-spec/verify-identity.py` re-checks 28 properties of the
recomputation (it prints `all 28 checks passed`).

> **This paragraph named `ece4037a…` as current until 2026-09-20, and that was
> stale.** The trusted-local architecture change added a second acceptance-spec
> input and restated the isolation input, moving the identity to `549732b5…` (the
> `identity_history` entry in the lock). The manual was not updated in the same
> change as the lock, so it described a superseded identity — the same class of
> defect as a stale install: the artifact moved and the description of it did
> not. `ece4037a…` is retained below as history.

> **The identity has been re-derived four times, and the sequence is the point.**
> The oldest recorded value was `0ca14d4e…`. Two inputs had moved away from it:
> `acceptance_spec_sha256` (the 112-case spec was installed, changing the digest)
> and `launcher_realpath`, which had been written through Python escape
> processing — `\apps\` became BEL (`0x07`) and `\bin.js` became backspace
> (`0x08`), so the field read `dsh-src\u0007pps\cli\lib\bin.js`. The **mangled**
> value is what the old hash was computed over, so `0ca14d4e…` described a path
> that does not exist. Recorded as G-FIX-11. It was then recomputed to
> `73da4c62…`, then to `6b214b9f…` when `host_profile_digest` moved because the
> profile patch gained the `agent-presets` row and lost its duplicate
> `daily-work-host` insert, then to `ece4037a…` when the preset root's Windows
> drive-letter strip was added (G-FIX-13), and finally to `549732b5…` when the
> deployment stopped claiming an isolation domain at all (trusted-local, no
> sandbox). **Each re-derivation is
> the invalidation the paragraph above promises working as intended, not a
> regression.** Two of the four were corrections of a real defect rather than
> routine drift, which is worth reading as a warning: an identity digest proves
> the inputs have not changed since it was computed, not that they are right.

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

### The qualification source plane must be clean before a run — F11 / ID-06

```sh
cd /d/DSH/work/dsh-native-daily
node qualification/runners/check-source-plane.mjs
```

**A developer workspace may be dirty; the qualification source plane may not.**
Run this before a qualification run and read exit 1 as "do not start": a verdict
produced on a tree whose source identity nobody can state is not a verdict. Exit 0
is clean, exit 1 is dirty, and exit 2 is a broken invocation — kept distinct so a
broken rig can never be read as a statement about the source.

**This is an environment precondition, NOT part of the artifact identity.** The
identity is the built launcher digest + lockfile + profile/preset digests + the
resolved graph, and `python helpers/doctor.py` re-derives and verifies it — that is
the check that survives a dirty checkout. Neither check substitutes for the other.

**Do not place DSH_HOME, generated artifacts, qualification output, or test temp
directories inside `D:\DSH\src\dsh-src`.** That is where the two untracked
directories in the `ID-06` FAIL came from. Use `D:\DSH\home\<name>` for homes and a
directory outside the checkout for qualification output; use disposable worktrees
(`helpers/new-writer.ps1`) for upstream experiments.

Never `git checkout`/`reset`/`clean` the pinned checkout to make this gate green —
it is shared by every writer and by the deployment, and the gate names the remedy
rather than applying it for exactly that reason.

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
  --patch 'D:\DSH\work\dsh-native-daily\qualification\results\R9-delivery\r9-surface.patch.yml' \
  --no-open --port 0
# then read qualification/results/R9-delivery/probe-out.json
```

**Use `--port 0`.** Without it the host tries the composed default (3080) and a
second concurrent boot fails with `EADDRINUSE`; the probe's own `inject` never
satisfies, and you get a startup log rather than a result. This is the failure
this manual's own author hit first.

**Two traps in reading the result, both of which produced a false PASS in this
project's history — read them before trusting any probe output.**

1. **The probe writes to a FIXED path, so it is a shared mutable resource.** If two
   agents (or two terminals) boot with it, the second reader cannot tell whose
   result the file holds. A "successful" verification of a *broken* preset root was
   reported exactly this way once: the file on disk held another agent's run.
2. **The fix is to read the roots back out of the result and assert they name the
   home you booted.** `presetRoots[1].path` must contain your `<your-home>`. If it
   names a directory you never created, you are reading someone else's run — throw
   the result away rather than reporting it.

The R9 copy of the probe in `qualification/results/R9-delivery/` writes to
`probe-out.json` in that same directory, so it has trap 1 as well; trap 2 is the
check that catches it.

Measured on this machine — a fresh install following §2, booted from a foreign cwd,
with the probe adding no row, and `presetRoots[1].path` confirming the home
(`qualification/results/R9-delivery/surface-r9-verified-fresh-install.json`):
`toolCountAgentKey: 28`, `presetsListed` naming `daily-standard`,
`ipythonToolPresent: true`, `workToolPresent: true`,
`ipythonParameterNames: ["code"]`, `forbiddenLifecycleTools: []`, `error: null`.
`toolCountContextKey` is recorded alongside as `0`,
which is the contrast that shows the agent-keyed scope is the one that matters.

**Trap 4 — the build and the typecheck are different configs, and there is now ONE
official command for the typecheck.**

```sh
cd /d/DSH/work/dsh-native-daily
pnpm typecheck                          # THE official gate: both packages, tests included

tsc -p tsconfig.json        --noEmit    # WRONG for gate evidence: EXCLUDES src/**/*.test.ts
tsc -p tsconfig.check.json  --noEmit    # the config the official command drives, per package
```

`tsconfig.json` excludes test files so the build never emits them into `lib/`.
That exclusion is correct for the build and makes `tsc -p tsconfig.json --noEmit`
exit 0 **with or without** a test file present — a false pass. This was caught and
recorded in `qualification/results/M9.2-terminal-advanced/FINDINGS.md`; the
corrected config immediately surfaced two real type errors the old one hid.

**Cite `pnpm typecheck`, not either `tsc` line, as the typecheck.** The two configs
are not meant to mean the same thing — one is the BUILD face, one is the CHECK
face — so the fix is not to merge them but to give the project a single entry
point that covers the complete production graph. `pnpm typecheck`
(`helpers/typecheck.mjs`) discovers every package carrying a `tsconfig.check.json`,
resolves each with `--showConfig` and **refuses to pass if the resolved program
contains no `*.test.ts`** — so a future edit that re-adds the exclude cannot turn
the gate back into a false pass. Measured in both directions, with the control arm
`ID-05` names, in `qualification/results/R2-F10F11/mutation-test.txt`:

| Arm | Command | Result |
|---|---|---|
| clean tree | `pnpm typecheck` | exit 0 |
| type error in a PRODUCTION file | `pnpm typecheck` | exit 1, names `src/protocol.ts(335,7)` |
| restored byte-exact | `pnpm typecheck` | exit 0 |
| the SAME error in a TEST file | `tsc -p tsconfig.json --noEmit` | **exit 0 — MISSED it** |
| the SAME error in a TEST file | `pnpm typecheck` | exit 1, names `src/protocol.test.ts(129,7)` |

**Test count: 1084 collected across 47 files**, measured with `vitest list` at
commit `a1d6e6d`. That is a **collection** count, not a passing count: no
full-suite pass/fail run is recorded in this repository, and `vitest list` does
not execute anything. This figure replaces an earlier "592 across 37 files"
measured at `2d4534f`; it moved because the package gained the M2/M4/M5/M7/M8/M9
suites. It is a snapshot of a tree under active concurrent edit, so treat it as
"at `a1d6e6d`", not as a standing claim — a mid-edit tree does not parse, and a
collection count can legitimately move between two commits with no test added or
removed.

## 3. Doctor

```sh
python helpers/doctor.py --source /d/DSH/src/dsh-src
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

**An IPython kernel now exists and reaches the model, but the kernel-state-loss
recovery path described here is still `NOT_RUN`.** The earlier version of this
section said there was no kernel at all and cited a `grep` over
`packages/dsh-daily-work` for `ipykernel`/`jupyter_client`. That grep was correct
about that package and is now misleading about the product: the kernel lives in a
**second** package, `packages/dsh-ipython/` (see §8.1), which the composed profile
loads as a bundle and which a real Session sees as one `ipython` tool. What has
**not** changed is the subject of this section: nothing here is a measured
recovery path. The volatile-state table is a **specification**, the mechanism
findings below are probe-tier measurements, and no gate closes on them.

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

### 8.1 The limits, numbered

1. **`packages/dsh-ipython/` exists, is loadable, and reaches the model — but it is
   not the whole new architecture.** The package is a real bundle: `package.json`
   with `dsh.bundle.patch`, `cordis.patch.yml` mounting the kernel service at host
   level, a compiled `lib/`, a `presets/` row shipping the agent-scoped `ipython`
   tool, and a passing test suite. VERIFIED in a real boot on a fresh install:
   `toolCountAgentKey: 28` with `ipythonToolPresent: true`,
   `ipythonParameterNames: ["code"]`, `ipythonIsOnlyParameter: true`,
   `forbiddenLifecycleTools: []`, alongside `pwsh` — so the model's execution
   surface is **`pwsh` and `ipython` together**, not `python_exec` replacing the
   shell. There is still **no `python_exec` tool name** and the shell has **not**
   left the daily preset. What is unbuilt is the rest of the new target: the hard
   host-wide 30, the UI N control, and the observation/artifact contract in §6.
   See §8.2 for the 28-vs-27 catalog correction.
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

### 8.2 The catalog is 27 tools, and the count moved for a reason worth reading

> **CORRECTED 2026-09-20. This section previously said "28, not 27" and called the
> 27 stale. That was right when written and is now wrong, because the composition
> changed again: commit `35c829d` disabled the `tool-pwsh` row UNCONDITIONALLY
> (the shipped form was `!!js process.platform !== 'win32'`, which leaves PowerShell
> ON on Windows), so that IPython is the model's only execution surface. The
> current count on a fresh install is **27**, with `pwsh` ABSENT — and the absence
> is the point rather than a regression. The historical table below is kept because
> the sequence is instructive: the count has moved 27 -> 28 -> 27 for two entirely
> different reasons, and only the LAST move is a deliberate narrowing.**

**The current measurement** (`qualification/results/M12-deliverable-surface/surface-fresh-install.json`,
fresh install from §2, booted from `C:/Windows/Temp`): `toolCountAgentKey: 27`,
`ipython` present with `ipythonParameterNames: ["code"]`, **`pwsh` and `bash` both
absent**, `work` present, `error: null`. The same home was re-installed and
re-booted a second time from the documented backslash-`DSH_HOME` form and agreed
(`surface-docform.json`).

Earlier revisions of this manual and of `README.md` recorded the composed
`daily-standard` catalog as **"27 tools including `pwsh` and no `python_exec`"**,
citing `qualification/results/M8.5-c2-real-boot/e2e-tool.json`. That file is real
and still on disk, but it was measured **before** the `ipython` tool row shipped,
so it is now a stale measurement rather than a current one. The number is 28.

| Evidence | When | Agent-keyed tools | `ipython` | `work` |
|---|---|---|---|---|
| `M8.5-c2-real-boot/e2e-tool.json` | before the preset row shipped | **27** | no | yes |
| `M11-ipython/e2e-tool.json` | via a verification overlay that INSERTED the row | **28** | yes | yes |
| `M12-deliverable-surface/surface.json` | the `DSH_HOME`-form root, installed as `daily-candidate` — **and see the contamination note below** | **28** | yes | yes |
| `R9-delivery/surface-r9-verified-fresh-install.json` | **fresh install from §2, foreign cwd, roots confirmed to name the booted home** | **28** | yes | yes |

> **The `M12` row carries two caveats the other three do not.** First, its
> `presetRoots` name `canary8/profiles/daily-candidate/presets` — that is the
> **`DSH_HOME`-form** root, the *second* failed attempt recorded in Trap 6, which
> hardcoded the install name. It worked because that home really was installed
> under that name. Second, and worse: the probe writes to a fixed path, and the run
> recorded there was produced by a *different* `DSH_HOME` than the one being
> booted — the file was read as one agent's result while holding another's. It is
> recorded as **G-FIX-13** in `docs/GAPS.md`. Its *content* agrees with the other
> three rows, which is why it is not withdrawn, but **a reader should cite the R9
> row**: it is the one whose `presetRoots[1].path` provably names the home that was
> booted, and whose root is the shipped `ctx.baseUrl` form.

**Why the count went 27 -> 28 -> 27, which is two different stories.** The first
27 was a catalog measured BEFORE the `ipython` tool row shipped, so the number was
right and incomplete. The 28 was a catalog that had gained `ipython` and still
carried `pwsh`. The current 27 is a catalog that has `ipython` and has had `pwsh`
removed on purpose. **So the number alone tells a reader nothing** — which is why
every row above records `ipython` AND `pwsh` alongside it, and why the current
claim is stated as "27 with pwsh absent" rather than as "27". A count that moves in
both directions for different reasons is exactly the kind of value that should
never be cited without its composition.

Each row is a true measurement of the tree it was taken on. The `M11` row reached
28 only through a verification overlay that INSERTED the tool row, which is why it
proves the tool works when a row is present without proving the product carries
one — the weaker-oracle mistake recorded as G-FIX-04/G-FIX-05/G-FIX-12.

**Both directions are recorded, which is what makes this a measurement rather than
an assertion.** The same manual, followed the same way, against the *pre-fix*
profile patch — whose root was `new URL('presets/', ctx.baseUrl).pathname` with no
drive-letter strip — produced `sessionCreated: false`, `toolCountAgentKey: 0`,
`ipythonToolPresent: false`, and
`error: "RemoteError: agent-presets: preset \"daily-standard\" not found (available: standard, ptc, minimal, cordis)"`.
That run is kept at
`qualification/results/R9-delivery/surface-r9-broken-pathname-form.json`. A reader
who wants to know what a silently-broken preset root looks like should read it: the
host boots, the services mount, and **only the tool count reveals the failure**.

One caveat a reader must not lose: **a tool appearing in a catalog is not a spec
PASS.** A catalog proves the row is wired, not that the behaviour behind it
satisfies its cases. The trusted-local spec is
`qualification/specs/acceptance-spec.trusted-local-v1.json` — **109 cases**, whose
verdicts are filed in place as they are established. At the time of this
correction 22 were filed (18 PASS / 4 FAIL) and the rest `NOT_RUN`; read the spec
itself for the current state rather than this sentence, which is a snapshot.

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

Current state, **re-read from `qualification/gates.json` on disk and not copied
from an earlier revision of this file**. The 104 old-spec cases divide
`required_for: daily_ready` **88**, `offline_qualified` **10**, `conditional` **6**:

```
total 104 = PASS 85 · NOT_RUN 10 · FAIL 2 · BLOCKED_EXTERNAL 1 · NOT_APPLICABLE 6
of the 88 mandatory:  PASS 75 · NOT_RUN 10 · FAIL 2 · BLOCKED_EXTERNAL 1
of the 10 offline_qualified: all 10 PASS
of the 6 conditional:        all 6 NOT_APPLICABLE
promotion_decision: NOT_READY   (qualification/gates-summary.json)
```

**Every non-PASS mandatory gate, named with its reason** — this is the full basis
of the verdict, and there are 13 of them:

| Gate | Status | One-line reason |
|---|---|---|
| `A12` | `NOT_RUN` | The real daily host was never qualified end to end. PARTIAL: it booted to the CREDENTIAL boundary — real port bound, fence 401, token URL → cookie → 200 app shell, `session/create` + `session/list` round-tripped, both C2 changes in the booted graph — then stopped at `MISSING_CREDENTIAL` because no API key is present. No model turn ran. |
| `C01` | `BLOCKED_EXTERNAL` | T1 measured (20 submitted against N=10; ten admitted, ten refused, ten distinct children each reaching a real model request); T5, the live paid run, is blocked. |
| `E01` | `FAIL` | A confined child **read** a canary secret outside the workspace root verbatim, exit 0, under both `read-only` and `workspace-write`. The boundary is writes only and the seam has no read lever in principle. |
| `E02` | `NOT_RUN` | PARTIAL: the surface shape is proven (no terminal tool in the preset, none added here); no live model-to-control-plane probe has been run. |
| `E06` | `FAIL` | A confined child completed a real HTTP round trip and connected to a public address under both modes. No egress control exists in the seam. |
| `E12` | `NOT_RUN` | Verification-code isolation has not been exercised; the verifier is not built. |
| `R01` | `NOT_RUN` | PARTIAL: the four links are proven against different substrates and each test says which; the full real search chain is not. |
| `U01` | `NOT_RUN` | No real coding task has been run under a frozen configuration. |
| `U02` | `NOT_RUN` | No real research task has been run. |
| `U03` | `NOT_RUN` | No sustained daily load has been run. |
| `U04` | `NOT_RUN` | No paired C0/C1/C2 comparison has been run. |
| `U05` | `NOT_RUN` | No canary upgrade has been run. |
| `U06` | `NOT_RUN` | No rollback has been exercised. (The temp-home rehearsal in §12 is a rehearsal, not this gate.) |

**The external blocker, named exactly.** `compatibility.lock.json` →
`runtime_authorization.live_provider_budget_authorized` is **`false`**. That single
field is what holds `C01` at `BLOCKED_EXTERNAL` and is the reason the paid halves
of the new-spec `ECO-07`/`ECO-08`/`UPG-07` families are blocked too. The lock also
records `budget_amount: null`, `restart_resume_authorized: false` and
`external_publication_authorized: false`. **A key merely being present on the
machine would not change this**: the field is an explicit authorization, not a
credential check.

**What a reader would have to authorize or fix to move the verdict.** Nothing here
is a request, and none of it is done:

1. **Authorize a live provider budget** (`live_provider_budget_authorized: true`
   plus an amount) — unblocks `C01` and the paid halves of the new spec. This is
   the only item that is purely an authorization.
2. **Fix the two `FAIL`s, which are platform facts rather than unbuilt work.**
   `E01` and `E06` cannot be closed on this host: the Windows sandbox seam has no
   read lever and no network vocabulary. Closing them means moving the production
   path to the documented Linux/SSH execution world, not editing this repo.
3. **Build and measure the ten `NOT_RUN` gates** — the real daily host (`A12`), the
   control-plane probe (`E02`), verification isolation (`E12`), the real search
   chain (`R01`), and the five `U` gates (a real coding task, a real research task,
   sustained load, a paired comparison, a canary upgrade, and an exercised
   rollback).
4. **Build the new architecture**, which is a separate and larger obligation: the
   112-case spec is **112/112 `NOT_RUN`** and shares **zero** case ids with this
   104-case report, so no gate above is progress toward it. See §8.1 and
   `docs/DELETE-AUDIT.md` §4.

**`NOT_READY` means the system is not certified for daily use, and the report says
so in its own vocabulary rather than in a footnote.** It does not mean the
mechanisms are unproven — 85 gates pass, and several of them are load-bearing
(ten children admitted through the real `startContinuable` seam; a run surviving a
real `SIGKILL`; an A→B→A mutation caught by an immutable snapshot). It means the
mandatory set is not closed.

Two further things `NOT_READY` covers that a reader might otherwise miss:

- **Two mandatory gates are honest FAILs, not gaps.** E01 and E06 were measured and
  the measurement contradicts the requirement. Re-reading them as "not yet
  verified" would understate them.
- **The old report's numbers do not carry over, and its evidence is now fully
  consistent.** Its 104 cases share **zero** ids with the new 112-case spec.
  An earlier revision of this file said "3 of 127 references no longer match the
  file on disk"; **that is no longer true and was checked rather than assumed** —
  re-hashing all 127 evidence references in `gates.json` against disk gives
  **127 match, 0 missing, 0 stale**. The T05/T06/T08 rows cite
  `615adaad87d29e3c…`, which is what
  `qualification/results/M9.2-terminal-advanced/FINDINGS.md` hashes to now. See
  `docs/DELETE-AUDIT.md` §4.1, and `docs/GAPS.md` G-VER-05 for the retraction.

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
  tasks. A kernel now exists (§8.1) and its memory is still not in the backup: it
  is process memory, and no restart path in this repo replays past cells.
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

**Read the honesty marker first: this procedure has been rehearsed, not
exercised.** No real newer version of this system has ever been rolled back,
because no version has ever been promoted — the daily home does not exist. What
exists is a rehearsal over a temp home with a fixture standing in for the newer
version (`R4-upgrade/u06-rollback-rerun.json`, 12/12 steps PASS, and its own
`notClaimed` list says a real newer version and a real remote were not involved).
Treat the sequence below as a **plan whose steps are individually evidenced**, not
as a procedure that has run against production. The rehearsal's own `notClaimed`
array is the field to read.

### The concrete sequence

Run every step from the **new** install's directory, with the same `DSH_HOME` the
failed version was booted under. Do not reuse a home across two versions.

```sh
export PATH="/d/DSH/tools/bin:$PATH"
export DSH_HOME='D:\DSH\home\<your-home>'

# 0. STOP. Do not roll back under a live host. Confirm nothing is serving:
#    no `node .../bin.js` process holds this DSH_HOME's storages/ directory.
#    If one does, stop it first — a rollback under a live writer is the exact
#    race the home lock exists for, and the default profile does not set it.

# 1. Capture the FAILING state before touching it, so the rollback is reversible.
cp -r "$DSH_HOME/profiles/<new-profile>" "$DSH_HOME/rollback-evidence/profiles-$(date +%s)"
cp -r "$DSH_HOME/storages"                 "$DSH_HOME/rollback-evidence/storages-$(date +%s)"

# 2. Record the digest of what you are about to restore, so step 6 can compare.
#    (Tree digest, not presence — a directory that exists is not a restore.)
find "$DSH_HOME/rollback-evidence" -type f -exec sha256sum {} + | sort > /tmp/r9-before.txt

# 3. Reconcile external effects FIRST, from the REMOTE, by operation id.
#    Do this before the rewind: after it, the local ledger that names the
#    operations may refuse to open (see §11 and step 5). Rolling back software
#    does not withdraw a remote action, so this step is not optional.

# 4. Restore the old artifact AND the old state snapshot together. Both, or
#    neither: an old artifact over migrated state is not a rollback, it is a
#    second failure. The rehearsal restored the snapshot byte-for-byte and
#    asserted the digest equal to the one taken while quiescent.

# 5. Expect the local effect ledger to refuse to open. That refusal is the
#    measured, correct behaviour (DomainError: stored record ... does not match
#    its schema) and is why step 3 runs first.

# 6. Verify by TREE DIGEST, not by presence.
find "$DSH_HOME/profiles/<old-profile>" -type f -exec sha256sum {} + | sort | diff - /tmp/r9-before.txt

# 7. Re-open the restored version and confirm it reads the state. A version that
#    starts is not proof it reads; a schema that cannot be migrated refuses to
#    start rather than silently reading a backup, and that refusal is correct.
```

### The three rules the sequence encodes

1. Restore the old artifact **and** the old state snapshot the new version has not
   migrated. Both, or neither.
2. **Reconcile external effects the new version already produced, before the
   rewind.** Rolling back software does not withdraw a remote action. Expect the
   local ledger to be unusable afterwards (§11) and reconcile from the remote.
3. A schema that cannot be migrated safely **refuses to start** rather than
   silently reading a backup. That refusal is correct; plan for it rather than
   working around it.

**VERIFIED as a rehearsal, over a temp home:**
`qualification/results/M9.20-real-tasks/u06-rollback.mjs` — old artifact + old
consistency snapshot restored byte-for-byte (tree digest equal), the external
effect reconciled and **still present in the world**, and the transport invoked
**zero additional times**. Re-run and re-recorded at
`qualification/results/R4-upgrade/u06-rollback-rerun.json` (12/12 PASS). No real
newer version was installed; the "new version" is a fixture over the same built
artifact with a bumped version string, and no real remote was contacted. The
report's own `notClaimed` array says exactly that, and it is the field to read
rather than the PASS count.

**NOT VERIFIED, and it must not be read as verified:** the `cp`/`find`/`diff`
commands in the sequence above are this manual's transcription of what the
rehearsal did in Node. **This exact shell sequence has not been run end to end by
anyone**, and the rehearsal's `notExercised` field names its own substitutions.
Where the two disagree, the JSON is the evidence and this block is the plan.

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
