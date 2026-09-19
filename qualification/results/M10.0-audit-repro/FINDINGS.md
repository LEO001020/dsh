# M0 — identity, environment, and reproduction of the audit's probes

Audit package: `DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20`, verified against
its own `SHA256SUMS`. The package explicitly labels itself a **design contract, not
a qualified implementation**, and states its 112 acceptance cases are all
`NOT_RUN`. Nothing here inherits an old PASS.

## 1. Repository and checkout identity

| Item | Value |
|---|---|
| Working repo | `D:\DSH\work\dsh-native-daily` |
| Branch / HEAD at M0 start | `master` @ `aa2c5c0` |
| Upstream checkout | `D:\DSH\src\dsh-src` |
| Upstream commit | `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| Built launcher | `apps/cli/lib/bin.js` (present) |
| Audit seed commit | `ddefc45fbc...` — **matches**, so no version-drift table is owed |

The audit names the implementation repo as `LEO001020/dsh`. This machine's working
tree has **no git remote** and no `00-plan` / `01-dsh-source` audit snapshots; the
implementation lives at `work/dsh-native-daily` instead. Recorded as a divergence
rather than silently mapped: the audit's file paths (`02-implementation/...`) do
not exist here, and its `src/host.ts` references resolve to
`packages/dsh-daily-work/src/host.ts`.

## 2. The install was moved mid-session, which broke every junction

`D:\DSH` was renamed to `D:\Code\DSH` and then moved back. Junction targets are
stored as absolute paths, so during the move **every** `node_modules/@deepseek-ai/*`
link pointed at a non-existent directory and the package could not resolve a single
DSH dependency.

`packages/dsh-daily-work/link-dsh.cmd` hardcoded `set SRC=D:\DSH\src\dsh-src`. It
now derives the install root from the script's own location and accepts `DSH_SRC`
as an override, so a future move does not silently break resolution again. Two
real defects were found and fixed while making it work:

1. **`if exist` does not normalize a path containing `..`.** Checking
   `%REPO%\..\..\src\dsh-src\package.json` reported "missing" for a checkout that
   was present. The install root is now materialised with a `pushd`/`popd` round
   trip before any existence check.
2. **The depth was wrong twice** before the layout was measured rather than
   assumed. `%~dp0` is `<install>\work\<repo>\packages\dsh-daily-work\`, so the repo
   is two levels up and the install root is two more.

After the fix: `require.resolve('@deepseek-ai/dsh-tools')` →
`D:\DSH\src\dsh-src\packages\core\tools\lib\index.js`, and `vitest run
src/states.test.ts` → 21/21 pass.

## 3. Python / IPython stack — the M3 substrate is already present

Measured with `Python314\python.exe`:

```
python        3.14.3
IPython       9.16.1
ipykernel     7.3.0
jupyter_client 8.10.0
zmq           27.2.0      <- imported as `zmq`, NOT `pyzmq`
numpy 2.4.6 · pandas 3.0.5 · pyarrow 25.0.0 · duckdb 1.5.5
```

**No installation is required for M3.** The audit's design assumed the Jupyter
stack would have to be obtained; here it is already present, which removes a
scheduled blocker.

A correction to my own first reading: `import pyzmq` fails, and I briefly recorded
pyzmq as missing. The distribution is named `pyzmq` but the **module is `zmq`**.
The stack is complete.

## 4. Both audit probes reproduced locally

The audit's probes were produced on a Unix host. Both were re-run here so their
claims rest on this machine rather than on inheritance.

### 4.1 Stale-lock interleaving — reproduced, with a portability defect

`probes/stale_lock_interleaving.py` **cannot run on Windows**: it imports `fcntl`
at module scope and fails with `ModuleNotFoundError: No module named 'fcntl'`
before any assertion executes. The audit's lock-race conclusion therefore rested on
a host that is not the deployment target.

`stale_lock_windows.py` (this directory) reproduces the interleaving using the
same `os.rename`/`os.link` sequence — which is platform-independent — and
re-expresses only the stable-handle control with `msvcrt`:

```json
{ "stale_lock_race_reproduced": true,
  "both_contenders_return_success": true,
  "second_contender_renamed_live_first_lock": true,
  "final_lock_owner": "B",
  "stable_handle_lock_second_acquisition_rejected": true,
  "trace": [ step1 both observe "stale",
             step2 A moves "stale", acquires
             step3 B moves "A"  <- a LIVE lock, acquires ] }
```

**Confirmed on Windows.** The protocol admits two winners under a legal
interleaving because `os.rename` binds to the NAME, not to the identity observed
earlier. The control also confirms the fix direction: a lock held on a **stable
file handle** refuses a second acquirer, so the repair is "hold an fd", not "add a
retry or a TTL".

### 4.2 IPython mechanics — 8/8 reproduced

```
OK  real_ipython_and_magic
OK  one_cell_512_simulated_bounded_observations
OK  persistent_working_state_next_cell
OK  exception_does_not_roll_back_namespace
OK  two_kernels_namespace_separate
OK  interrupt_and_reuse_simple_python_loop
OK  kernel_restart_loses_volatile_state
OK  stdin_disabled
```

These are **protocol self-checks only**. As the audit states, no DSH native tool
and no LLM participated, so they are not evidence for any DSH or data-plane gate.

## 5. A finding the audit did not record: the kernel transport is UNENCRYPTED

Every kernel start in the probe emitted, three times:

```
[IPKernelApp] WARNING | Kernel is running over TCP without encryption. All
communication (including code and outputs) is sent in plain text and is
susceptible to eavesdropping. Use IPC transport or launch with kernel
manager-provisioned CurveZMQ keys to enable transport encryption.
```

The audit's architecture section says the connection file is owner-only and that
native-tool callbacks use a separate bounded IPC. It does **not** record that the
default `jupyter_client` start path yields a plaintext TCP transport. This matters
because:

- `SEC-03`/`SEC-07` treat the execution world as a security boundary, and a
  plaintext kernel channel on a shared host is not one.
- The kernel connection file carries the HMAC key that authorises execution; a
  readable connection file is therefore an execution capability, which the audit
  itself notes ("connection keys are not a user-facing capability ticket").

Recorded as an open item for M3: the kernel must be started with **IPC transport**
on POSIX, and on Windows with manager-provisioned CurveZMQ keys, and the choice
must be asserted by a test rather than left to the default.

## 6. What M0 establishes, and what it does not

**Establishes:** the checkout is intact at the audited commit; the build chain
resolves again after the move; the Python/IPython substrate for M3 is present with
no installation; the lock race is real on Windows; the IPython mechanics the design
depends on are real.

**Does not establish:** any DSH integration. No DSH tool ran under a kernel, no
native observation reached Python, no capacity or data-plane behaviour was
exercised. All 112 acceptance cases remain `NOT_RUN`, and the promotion decision
remains `NOT_READY`.
