# T3 — the shell / permission plane: findings and final verdict

**Verdict: PASS, 12 of 12 assertions, `driver.json.exitCode` 0.**
Evidence: `boot.json` (probe) and `driver.json` (boot facts), both from the run at
2026-09-20 06:57, port 6475, `portReleased: true`.

---

## 1. The failing assertion was my own probe's artifact — but not for the reason assumed

The inherited run reported `activationWarningCount: 1` with exactly one inactive
row:

```
{ id: "verify-t3-shell",
  name: "file:///D:/DSH/work/dsh-native-daily/qualification/runners/verify-t3-shell.mjs",
  disabled: false, fiberState: 1, missing: [] }
```

**It is the probe's own row.** Two independent measurements establish this, and
the first one also corrects the diagnosis that was handed to me.

### 1a. `fiberState: 1` is LOADING, not pending

The dispatch described state 1 as "pending". It is not. The enum is declared

```
export const enum FiberState { PENDING, LOADING, ACTIVE, FAILED, DISPOSED, UNLOADING }
```

at `vendor/cordis/src/fiber.ts:147`, so `PENDING === 0`, `LOADING === 1`,
`ACTIVE === 2`. `packages/boot/app-boot/src/index.ts:679-682` pins the same
numbers (`FIBER_PENDING = 0`, `FIBER_ACTIVE = 2`).

This matters because the two states have different meanings. `LOADING` is a
fiber whose plugin callback is **currently running**; `PENDING` is one waiting
on a service. The row is LOADING because a fiber becomes `ACTIVE` only after its
`apply` resolves (`vendor/cordis/src/fiber.ts:323`), and the probe reads the
table **from inside its own `apply`**. So the probe necessarily observes itself
as LOADING. The `missing: []` field already said so: no service was missing.

### 1b. The post-audit checkpoint — the same row, ACTIVE, with no filter

The prior run's fix (excluding the probe's own row) was correct but rested on an
argument rather than a second measurement, and the stored `boot.json` predated
even that fix (results written 05:19:36; the probe edited 05:21:18). Rather than
re-assert the exclusion, I added a checkpoint that needs no exclusion.

`appReady` is committed only after `boot()` returns
(`apps/cli/src/profile-boot.ts:326-328`), and `boot()` runs `loader.await()` and
then `auditStartupEntries` before returning
(`packages/boot/app-boot/src/index.ts:956-957`). A listener on `appReady`
therefore reads the entry table **strictly after the product's own audit**. The
probe registers one and re-reads the tree with **no row excluded**:

| checkpoint | rows excluded | inactive | probe's own row |
|---|---|---|---|
| mid-apply | probe's own row | **0** | `fiberState: 1` (LOADING) |
| post-audit | **none** | **0** | `fiberState: 2` (**ACTIVE**) |

`postAuditProbeRowState: 2` is the direct, unfiltered proof that the row did
activate. The mid-apply `fiberState: 1` was the observation point, not a
failure. Both checkpoints are asserted, so neither can carry the verdict alone.

### 1c. It also fixes an ambiguity the prior run could not resolve

An empty stderr warning block is ambiguous: a host killed before the audit
printed would also show nothing, and "no warning" would then mean "no audit
rather than "no inactive row". `postAuditRan: true` is the **positive control**
— it proves the audit reached its checkpoint, so the zero can be read as a
measurement. The probe now writes its result exactly once, from that checkpoint,
so the harness cannot kill the host before the post-audit numbers exist.

## 2. `pwshToolPresent: false` is INTENDED — confirmed, not re-enabled

The absence is deliberate. `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
disables the model-facing row unconditionally:

```yaml
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: true
```

Measured, not assumed — the probe now asserts the *reason* rather than the bare
absence, because `pwshToolPresent: false` cannot distinguish "deliberately
disabled" from "enabled but never activated", and only the second is a defect:

- `modelShellRow: { present: true, disabled: true, fiberState: null }` — present
  and disabled, never present-and-loading.
- `pwshAbsenceIsIntentional: true`
- `ipythonReplacesPwsh: true` — read from the real Session catalog (27 tools,
  `ipython` present, `pwsh` absent, `read`/`write`/`edit` present), which is
  independent of the loader-row table.

**This also exposed a live defect in the prior run's own probe.** `byId()`
returned the raw row, which has no `present` field, so the inherited
`modelShellRowIsPending: false` was computed from `row.present === true` — false
for a row that *exists*. It reported the right value for the wrong reason and
was not evidence. Fixed by normalising through an explicit `rowShape()`, and
recorded in the probe so it is not reintroduced.

## 3. The shell / permission plane — final state

All measured in a real composed `daily` profile boot, from `C:\Windows\Temp`:

| fact | value |
|---|---|
| `shellClassName` | `PwshLocalExecutor` |
| prototype chain | `["PwshLocalExecutor", "ShellExecutor", "Service"]` |
| `shellSandboxModeIsUndefined` | `true` (`sandboxMode: null`) |
| `shellIsSandboxSubclass` | `false` |
| `permissionPresets` service / row | absent / present-and-disabled |
| `approvalPolicy` | `"never"` |
| `pwshEscalationFields` | `[]` |
| `toolCount` | 27 |
| `entryCount` / active / disabled | 177 / 145 / 31 |
| `bootCwd` | `C:\Windows\Temp` |

`bootCwd` is load-bearing and inherited: the preset root
`D:/DSH/home/t3-shell/profiles/daily/presets/` resolved from **outside** the
profile directory, which independently confirms the cwd-dependent preset-root
defect is fixed (G-FIX-13).

---

## 4. Build identity — which artifact these numbers describe

Every home on this machine installs `dsh-ipython` and `dsh-daily-work` through a
`link:` (`$DSH_HOME/profiles/daily/node_modules/` holds exactly those two, both
symlinks into this repo). A booted profile therefore executes the repo's **built
`lib/`**, never its `src/`. These results are measurements of an artifact.

**Ordering, so this is reproducible:** I rebuilt both packages immediately
before the measured run (`tsc -p tsconfig.json`, exit 0 each), then booted. The
result records the SHA-256 of every lib on the probe's load path, and the driver
hashes them **before and after** the boot:

- `artifactsStableDuringBoot: true`, `artifactsChangedDuringBoot: []`
- `libNewerThanSrc: true` for all six tracked src/lib pairs

The digests are in `boot.json` (`buildIdentity.libDigests`) and `driver.json`
(`buildIdentity`). A sibling agent rebuilt `dsh-daily-work/lib` at 06:49 while I
was investigating, which is exactly why the before/after check is now part of
the driver's exit condition: a moving artifact must not exit 0.

### 4a. The composition under test is unchanged and committed

The composition the boot actually read is the home copy
`$DSH_HOME/profiles/daily/presets/daily-standard/agent.cordis.yml`. Both it and
the repo copy `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
hash to `16bc20e559d0c05b810876522fd468952b421a69ed2b5276a3ddd06c01053bce`
(verified identical, and the repo copy is clean in `git status`). The profile
patch hashes to `5b8b2a8e5d9ae13d35c1d86833f8b96eeb84078a13027a08efc1379a6fc8afb4`.
So this verdict describes a composition that is still the current one.

(One caveat worth recording because it nearly produced a false finding here: a
hash of the repo copy taken moments earlier returned a *different* digest,
`373d275a...`. Re-read sequentially, both copies were `16bc20e5...` and
identical. The differing read was a transient sample taken while a sibling agent
rewrote the file mid-write. A single hash of a file another process is editing
is not evidence of a changed composition — re-read before concluding.)

`buildIdentity` deliberately does **not** assert freshness. A stale lib that is
off this probe's load path is not a defect in this gate — it is a label for a
reader.

### 4a. One stale artifact, off this gate's path (reported, not fixed)

`packages/dsh-ipython/src/bridge.ts` (06:48:09) is newer than
`lib/bridge.js` (06:41:38). I rebuilt it (now 06:55:36, fresh). It is **not** on
this probe's load path: no built lib imports `bridge.js`, and no composition row
names it — a sibling test (`src/bridge-seam.test.ts:912`) asserts the package
entry points never reach `bridge.ts` or `native-call.ts`. So it is unrelated to
the shell/permission plane and does not affect this verdict. Recorded because it
is the same class of stale-artifact trap that produced G-SEAM-29.

---

## 5. What this does NOT prove

Stated so the PASS is not over-read:

- **Not** that the `pwsh` tool can execute a command. The row is disabled by
  design; what is proven is that the local executor is mounted and that its
  `sandboxMode` is `undefined`. Execution is T2/other agents' surface.
- **Not** that `permission-presets` *would* throw. That it does is a
  **source-level** fact (`packages/interaction/permission-presets/src/index.ts:214-216`);
  what is measured here is the absence of the row and the `undefined`
  `sandboxMode` that together make the throw reachable.
- **Not** that the approval policy reaches the model's prompt. The value
  `'never'` is read from the live service config; whether the sentence appears
  in the runtime context is not asserted.
- **No** containment claim of any kind. The IPython kernel is unconfined and
  runs as the same OS user (G-SEAM-25); disabling `tool-pwsh` removes a second
  interface, not a capability.
- **No** load, benchmark, or CPU-saturating arm was run.

## 6. Measurement classification

- **Measured** (booted a real composed profile and read the live graph):
  everything in the tables above, the two activation checkpoints, the row
  states, the tool catalog, the artifact digests and their stability.
- **Read in source** (not re-derived at runtime): the `FiberState` numbering,
  the `ACTIVE`-only-after-`apply`-resolves rule, the `appReady`-after-`boot()`
  ordering, the `permission-presets` throw, and the intent behind the preset's
  `disabled: true`.

## 7. Reproducing

```
# rebuild the measured packages first (they are link:-ed into the booted home)
cd D:/DSH/work/dsh-native-daily/packages/dsh-ipython
  && node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json
cd D:/DSH/work/dsh-native-daily/packages/dsh-daily-work
  && node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json

# then the probe (boots one host from C:/Windows/Temp, exits 0 on PASS)
cd D:/DSH/work/dsh-native-daily
  && node qualification/runners/run-t3-shell.mjs
```

Exit code 0 requires all 12 probe assertions **and**
`buildIdentity.stableDuringBoot`.
