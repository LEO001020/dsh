# P12 STEP 1 — SOURCE MAP (runtime scratch root)

Measured on worktree `D:\DSH\work\wt-p12`, branch `wt/p12`, base `2e1b2c2`.

## (a) `DEFAULT_KERNEL_ROOT` and every reader of `kernelRoot()`

| what | file:line | text |
|---|---|---|
| package root derivation | `packages/dsh-ipython/src/kernel-plugin.ts:118` | `const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))` |
| broker path (correct, stays) | `packages/dsh-ipython/src/kernel-plugin.ts:121` | `export const DEFAULT_BROKER_SCRIPT = join(PACKAGE_ROOT, 'src', 'broker.py')` |
| **the defect** | `packages/dsh-ipython/src/kernel-plugin.ts:132` | `export const DEFAULT_KERNEL_ROOT = join(PACKAGE_ROOT, '.ipython-kernels')` |
| config doc comment | `packages/dsh-ipython/src/kernel-plugin.ts:150` | `/** Directory for per-session kernel working directories. Defaults to the package's own `.ipython-kernels`. */` |
| reader 1 — session-header-cwd fallback | `packages/dsh-ipython/src/kernel-plugin.ts:418-422` | `kernelWorkingDirectoryFor()`: `return this.kernelRoot()` when `agent.session.header.cwd` is empty |
| reader 2 — the definition | `packages/dsh-ipython/src/kernel-plugin.ts:433-435` | `private kernelRoot(): string { return this.config.root ?? DEFAULT_KERNEL_ROOT }` |
| reader 3 — scratch dir + everything under it | `packages/dsh-ipython/src/kernel-plugin.ts:478-497` | `const workingDirectory = join(this.kernelRoot(), sanitize(identity.sessionId))` then `bridgeDirectory = join(workingDirectory, 'bridge')`, `artifactDirectory: join(bridgeDirectory, 'artifacts')`, `clientDirectory: bridgeDirectory` |
| reader 4 — passed as the broker's cwd + spill/log dir | `packages/dsh-ipython/src/kernel-plugin.ts:518` | `workingDirectory,` into `KernelHost` |

Outside `kernel-plugin.ts`, the only other reference is a comment
(`packages/dsh-ipython/cordis.patch.yml:65`). `.gitignore:23` has
`.ipython-kernels/` — the tree is dirty by construction, which is why it was
ignored rather than fixed.

**The patch file does NOT set `root`.** `packages/dsh-ipython/cordis.patch.yml:51`
says `brokerScript` and `root` are "deliberately NOT SET HERE", so the DEFAULT is
what the product actually uses. `DEFAULT_KERNEL_ROOT` is therefore not a fallback
of last resort — it is the live value.

## (b) What actually writes into that directory, and how I established it

Established by RUNNING a real kernel, not by reading: probe
`qualification/results/P12-runtime/probe/runtime-location-probe.mjs` walks the
package tree before and after one real `KernelService.runCell`, so the entry list
is what the kernel created, not what the source suggests it creates.

Result: `qualification/results/P12-runtime/before-default-root.json`
(`packageScratchEntries`, 9 entries, all new):

```
.ipython-kernels/
.ipython-kernels\p12-probe-session/
.ipython-kernels\p12-probe-session\bridge/
.ipython-kernels\p12-probe-session\bridge\artifacts/
.ipython-kernels\p12-probe-session\bridge\dsh_bridge_client.py
.ipython-kernels\p12-probe-session\dsh_attribution_bootstrap.loaded
.ipython-kernels\p12-probe-session\dsh_attribution_bootstrap.py
.ipython-kernels\p12-probe-session\kernel.err
.ipython-kernels\p12-probe-session\kernel.out
```

`homeRuntimeEntries: []` — the same run wrote nothing under `$DSH_HOME`.
Same run, same cell: `cellOutcome: ok`, `transport: tcp`,
`curveKeysPresent: true`.

Writers, mapped to the entry each produces:

| entry | producer | file:line |
|---|---|---|
| `kernel.out`, `kernel.err` | broker opens them in `DSH_IPYTHON_KERNEL_DIR` | `packages/dsh-ipython/src/broker.py:635-636`, env set at `packages/dsh-ipython/src/kernel.ts:247-248` |
| `dsh_attribution_bootstrap.py` / `.loaded` | `write_attribution_bootstrap(work_dir)` | `packages/dsh-ipython/src/broker.py:664` |
| `dsh_bridge_client.py` | `BridgeServer` `clientDirectory` | `packages/dsh-ipython/src/kernel-plugin.ts:495` |
| `bridge/artifacts/` | `BridgeServer` `artifactDirectory` | `packages/dsh-ipython/src/kernel-plugin.ts:494, 506` |
| the Jupyter **connection file** | `KernelManager` via `jupyter_core.paths.jupyter_runtime_dir()`, NOT via our config | measured: resolves to `E:\zcode-labs\zloop-home\AppData\Roaming\jupyter\runtime` on this machine, i.e. a THIRD location, outside both the package and `DSH_HOME` |
| kernel spill files | `DSH_IPYTHON_SPILL_DIR` | `packages/dsh-ipython/src/broker.py:405` |

**Correction to the dispatch note, and it matters for the fix.** The connection
file is NOT written into the package — it goes to `jupyter_runtime_dir()`, which
is a user-profile directory outside both trees. So the fix must do two separate
things: (1) move what our config controls (`workingDirectory` and everything
derived from it) under `DSH_HOME`, and (2) explicitly PIN the Jupyter runtime dir
into the same DSH_HOME tree, because otherwise a third unmanaged location keeps
holding the HMAC-bearing connection file. `JUPYTER_RUNTIME_DIR` is currently NOT
set by this package — `packages/dsh-ipython/src/kernel.ts:240-255` sets five
variables and that is not one of them.

### CONTROL ARM (the measurement is worthless without it)

`qualification/results/P12-runtime/before-control-arm.json`: the same probe with
an explicit `root` under `DSH_HOME` reports
`packageScratchEntries: []` and 10 `homeRuntimeEntries`.

So the walk is measuring the kernel's writes and not incidental churn: with the
root moved, the package entries drop to exactly zero. A `String.includes` scan of
the source would have reported the same "defect present" for both arms.

## (c) The DSH_HOME-resolving helper that already exists — do not invent a second

`@deepseek-ai/dsh-home-paths`, source at
`D:\DSH\src\dsh-src\packages\util\home-paths\src\index.ts` (READ-ONLY pinned
checkout):

- `resolveDshHome(configured?, env?)` — `:87-91`. Precedence: explicit argument,
  then `$DSH_HOME`, then `~/.dsh`; an empty/whitespace `$DSH_HOME` is treated as
  unset rather than resolving to cwd.
- `dshHomePath(...segments)` — `:98-100`. `join(resolveDshHome(), ...segments)`.

This is the SAME resolver the rest of DSH uses: `packages/boot/app-boot/src/index.ts:18`
imports it, `:940` does `ctx.provide('dshHomePath', dshHomePath)` so `!!js`
config expressions can call it, and `packages/preset/agent-presets/src/index.ts:40,184`
uses it for `USER_PRESET_DIR`. Measured in the pinned checkout's own test:
`packages/boot/app-boot/tests/app-boot.spec.ts:966-992` asserts
`!!js dshHomePath('sessions')` evaluates to `<DSH_HOME>/sessions`.

**Constraint found while measuring:** `@deepseek-ai/dsh-home-paths` does NOT
resolve from this worktree. `createRequire(packages/dsh-ipython/package.json)
.resolve('@deepseek-ai/dsh-home-paths')` throws `MODULE_NOT_FOUND`; the
provisioned junction farm at `packages/dsh-ipython/node_modules/@deepseek-ai/`
has 13 entries and `dsh-home-paths` is not among them (`cordis`, `dsh-agent`,
`dsh-subprocess-local`, ... are). So the fix cannot simply import it without
either adding it to the junction farm or adding it to `package.json`
`peerDependencies`/`devDependencies`. This is a real provisioning dependency and
is recorded rather than worked around silently.

## Decision on §11.3, committed before the code

**TAKEN: the PREFERRED final — a DSH-owned venv at `$DSH_HOME/runtime/python`,
with the `DSH_PYTHON`-required arm as the documented fallback when bootstrap
cannot complete.**

Reasoning, in the order that decided it:

1. V5 §11.3 lists the venv as "best final deployment" and the required-variable
   form as what to do "if automatic bootstrap is deferred". Bootstrap is NOT
   deferred here: the only network-dependent step is the install of pinned
   packages, and I can implement discovery + venv creation + the doctor now.
2. **MEASURED: creating the venv needs no network and works.**
   `"<system python>" -m venv D:/DSH/home/p12/runtime/python` exited 0 in **5.8 s**
   and produced `Scripts/python.exe`, `Scripts/pip.exe`, `Scripts/activate*`.
   `ensurepip 25.3` is present in the system interpreter, which is why `pip`
   arrives without a download. The system interpreter is CPython **3.14.3**.
3. The install step is the part that needs the network and it is `BLOCKED_EXTERNAL`
   — no authorized budget. So the doctor must be able to reach a loud, exact,
   actionable failure WITHOUT it, which is exactly the second arm of §11.3. The
   two arms are therefore not alternatives to choose between; the venv arm is the
   target and the required-variable arm is what the operator sees when the venv
   is not yet provisioned.
4. The reason the acceptable-minimum arm alone is not enough: it fixes the
   personal-path defect but leaves every fresh clone with a manual step that no
   file records. V5's own PYTHON-PORTABLE case asks for "bootstraps managed venv
   OR fails loud with one documented configuration action" — implementing only
   the second arm satisfies the letter of the case and none of the intent.

**What is NOT claimed about this decision.** Creating a venv is not the same as
having a usable kernel environment: a fresh venv has no `IPython`, `ipykernel`,
`jupyter_client` or `pyzmq`, and until the pinned install runs, the managed venv
is a directory that cannot run a kernel. The doctor must therefore REFUSE to
report READY on a venv whose imports do not resolve, or the "managed venv"
becomes a new way to look healthy while broken.
