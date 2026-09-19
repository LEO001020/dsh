# M11 — the real IPython execution surface

**Scope.** `packages/dsh-ipython`, a new package (not an overload of
`dsh-daily-work`): a trusted broker over `jupyter_client`, a bounded
host↔broker protocol, a host-level kernel service, and ONE model-facing
`ipython` tool. Requirements 1–12 of the M3 brief, each with a real test.

**What this is not.** No LLM participated. No capacity, memory-document or UI
work is claimed. The 112 acceptance cases in the audit package remain `NOT_RUN`
except where a row below maps to one of the 12 requirements, and the promotion
decision is unchanged.

**Evidence in this directory.** `tests.txt` (54/54, real output), `tsc.txt`,
`source-digests.txt`, `e2e-tool.json` (the real-boot probe), and the probes:
`probe-transport.py`, `probe-mechanics.py`, `probe-cases.py`,
`probe-late-attribution.py`, `probe-curve-authz.py`, with their JSON results.

---

## Summary

| # | Requirement | Result |
|---|---|---|
| 1 | Real IPython, not a CPython fake | **PASS** |
| 2 | Kernel transport not plaintext TCP | **PASS** — CurveZMQ over TCP; IPC impossible on Windows |
| 3 | Persistent namespace across cells | **PASS** |
| 4 | Top-level await, no wrapper | **PASS** |
| 5 | Exception does not roll back | **PASS** |
| 6 | stdin disabled, fails fast | **PASS** |
| 7 | Message correlation by parent id | **PASS** |
| 8 | Interrupt then reuse | **PARTIAL** — CPU loop PASS; await-suspended cell is `unknown`+reset (see below) |
| 9 | Late/unattributed output | **PARTIAL** — see the measured mechanism below |
| 10 | Bounded output | **PASS** |
| 11 | Kernel death changes the generation | **PASS** |
| 12 | ONE tool, one `code` parameter | **PASS** |

Two rows are PARTIAL. Both are stated with the exact measurement rather than
softened, and neither is a case of the code not trying: in each, the platform
behaviour bounds what is achievable.

---

## 1. Real IPython, not a CPython fake — PASS

`get_ipython()` returns `ipykernel.zmqshell.ZMQInteractiveShell`, asserted by
`isinstance` against the class object imported from `ipykernel.zmqshell`, not by
a string comparison. `%time` and `%who_ls` both execute, which is the
discriminator a bare `code.InteractiveConsole` cannot satisfy: magics are
IPython's input transformer, not Python syntax, so that line raises `SyntaxError`
on any other console.

`tests.txt` → `requirement 1: a real IPython shell, not a CPython fake` (2 tests).

A correction worth recording: the first version of this test asserted
`%who_ls sentinel_variable` contains the name. It returned `[]`, and the cause was
my misreading, not a kernel defect — `%who_ls`'s argument filters by TYPE, not by
name. Bare `%who_ls` is the correct form. Had I "fixed" this by loosening the
assertion, the test would have stopped distinguishing a working magic from a
broken one.

## 2. Kernel transport is not plaintext TCP — PASS

**The achieved transport is CurveZMQ-encrypted TCP.** `transport='ipc'` is
**impossible on this platform**: Windows libzmq answers
`ZMQError: Protocol not supported (addr='ipc://kernel-ipc-4')` before any kernel
starts (`transport-probe.json`). The audit's first preference is therefore
unavailable, and the second option — manager-provisioned CurveZMQ keys — is what
is used. `KernelManager(transport_encryption="required")`, never the default.

The test asserts the OBSERVED state, not the request:
- the connection file the kernel was actually given contains `curve_publickey`
  and `curve_secretkey`;
- the kernel's stderr does **not** contain `without encryption` — the exact
  warning M0 measured on the default path;
- `transport` is reported back from the connection file, so a manager that
  silently ignored the policy would be recorded as unencrypted.

**And curve keys are an AUTHORISATION boundary, not only encryption.**
`probe-curve-authz.py` tests the claim directly, because requirement 2's premise
is that the connection file carries the key that authorises execution:

| Arm | Result |
|---|---|
| Control: correctly keyed client executes | `ok` in 0.01 s |
| Keyless client (ports + HMAC key, **no** curve keys) | `Kernel died before replying to kernel_info`; `EXECUTED_WITHOUT_CURVE_KEYS: false` |
| Raw DEALER with no session envelope | no reply |
| TCP port reachable without the handshake | `true` |

The port is reachable and the client still cannot execute. So the plaintext
exposure M0 recorded was a **capability** leak, and closing it required
encryption — which is what the implementation now does.

`tests.txt` → `requirement 2: kernel transport is not plaintext` (2 tests).

## 3. Persistent namespace across cells — PASS

Cell 1 builds a `pandas` DataFrame and a function; cell 2 computes
`frame["n"].sum()` and maps the function over the column, asserting the VALUES
(`total: 10`, `mapped: [2, 4, 6, 8]`, `labels: ['a','b','c','d']`). A third test
mutates the frame in cell 2 and reads the mutation in cell 3, which shows the
object is genuinely shared rather than re-derived.

`tests.txt` → `requirement 3: the namespace persists across cells` (2 tests).

## 4. Top-level await, no wrapper — PASS

Three cases: a bare `await asyncio.sleep(0.05, result=21)` at cell top level; a
coroutine defined and gathered in one cell; and a coroutine CREATED in cell 1 and
awaited in cell 2. All return `ok`, and a wrapper requirement would make the first
a `SyntaxError`.

`tests.txt` → `requirement 4: top-level await works without a wrapper` (3 tests).

## 5. An exception does not roll back — PASS, and rollback is not claimed

The error is reported with `ename`, `evalue` and a traceback containing the
failing line. The assignment made before the `raise` survives into the next cell.
A second test asserts the honest partial-execution model: the statement AFTER the
raise never ran (`"after" in dir()` is `False`), so the test states what actually
happens instead of implying a transaction.

`tests.txt` → `requirement 5: an exception does not roll back the namespace`
(2 tests).

## 6. stdin disabled — PASS

`allow_stdin=False` is passed on every `execute_request`. `input()` raises
`StdinNotImplementedError` and `getpass` fails the same way; both are asserted to
return within 20 s (a hang would instead hit the cell timeout), and the kernel is
asserted usable afterwards.

`tests.txt` → `requirement 6: stdin is disabled and fails fast` (2 tests).

## 7. Message correlation — PASS, and this was a real defect first

A cell is complete only when BOTH the matching `execute_reply` and the matching
`idle` are observed, and every frame is matched by `parent_header.msg_id`.

**The first implementation was wrong and the test caught it.** `status()` and the
cell loop both called `kc.get_shell_msg()`, and that call CONSUMES: the status
request ate the cell's `execute_reply`. The cell then waited out its whole 120 s
budget and was reported `unknown` — a fabricated failure caused entirely by the
reader design. The fix is a single `ShellRouter` thread that is the only reader of
the shell channel; waiters register by `msg_id` before the request is sent, and
unmatched frames are counted, never delivered. The same test now passes in 5.0 s.

This also gives IPY-06 a concrete reason to be mandatory rather than defensive:
the supervisor reproduced a stray `kernel_info_reply` left by `wait_for_ready` on
the shell channel in ALL THREE transport modes, so a reader taking "the next shell
message" is wrong on the first cell of every kernel.

`tests.txt` → `requirement 7: only the matching reply and idle complete a cell`
(2 tests: a foreign `kernel_info_request` injected mid-cell, and the
`wait_for_ready` stray).

## 8. Interrupt then reuse — PARTIAL

**CPU loop: PASS.** Interrupt produces `KeyboardInterrupt`, and the next cell
reads a variable assigned before the interrupt, so the kernel is reusable.

**`await`-suspended cell: `unknown` + reset, which is the requirement's own
escape hatch, not a PASS for the interrupt.** Measured, twice:

```
probe-cases.py   interrupt_await_suspended:
  settled: false            after 20.15 s
  second_interrupt_settled: false   after a further 10.07 s
  process_alive_after: true
```

Two interrupts and 30 s do not settle a cell suspended in `await`, while a CPU
loop settles in ~1.8 s. The implementation therefore treats an interrupt that does
not settle within a bounded grace as `unknown`, resets the kernel, and advances
the epoch; the test asserts exactly that (`KernelOutcomeUnknownError`, outcome
`unknown`, `volatileStateLost: true`, epoch advanced, and the post-reset kernel
empty). **A false success is never reported**, which is the property the
requirement exists to protect. What is NOT achieved is a graceful
`KeyboardInterrupt` for the await case; that is a platform behaviour, and the
exact numbers are recorded rather than a claim of recovery.

**The two interrupt routes, measured** (`probe-interrupt.py`). Windows offers two
ways to interrupt a kernel and only one of them works:

| Route | Result |
|---|---|
| Control-channel `interrupt_request` | kernel logs `Interrupt message not supported on Windows`; cell never settles (16 s) |
| Win32 interrupt event (`interrupt_kernel()` in signal mode) | CPU loop settles in ~1.8 s |

So `interrupt_mode` must stay `signal`, and the message route is not a fallback.
The same probe confirms the recovery path the requirement depends on: a WEDGED
kernel (await-suspended, interrupt ignored) is still shutdownable —
`shutdown_kernel(now=True)` returned in 1.45 s and the pid was gone — and
`restart_kernel` after a `taskkill` works with the namespace genuinely lost
(`"x" in dir()` → `False`). A cell suspended in `await` does not settle even on a
fresh kernel and even when the await is wrapped in a `CancelledError` handler, so
this is the await path itself and not residue from an earlier test.

The grace window is 5 s: it is a real boundary between `interrupted` and
`unknown`, not a retry budget, and a longer value would only make the model wait
longer for the same reset.

`tests.txt` → `requirement 8: interrupt, then reuse the kernel` (2 tests).

## 9. Late / unattributed output — PARTIAL

**The measured mechanism, and why the requirement is not fully satisfiable.**
`ipykernel/iostream.py:600-607` resolves a stream's parent header from a
`contextvars.ContextVar`, falling back to a GLOBAL when the contextvar is unset. A
`threading.Thread` starts with an EMPTY context (an asyncio Task would copy one),
so a background writer never sees the contextvar and always takes the global —
which holds whichever cell most recently set it. `probe-late-attribution.py`
separates the two cases:

| Arm | Background write's parent id |
|---|---|
| A: no next cell | the ORIGINATING cell |
| B: during the next cell | the **NEW** cell |

So the kernel does **not** preserve the originating cell's id in general, and no
broker can recover an attribution the kernel itself did not stamp. This corrects
`TRANSPORT-FINDINGS.md` §"Other mechanics confirmed", which claimed the originating
id is preserved — that probe never ran a second cell, so it could not distinguish
"the originating cell" from "the cell that most recently set the global".

**What IS achieved and tested** (2 tests):
- output arriving after a cell went idle is classified `late_output` and is NOT
  folded into that cell's result. This closes the gap an id-only filter leaves
  open, because the kernel stamps such a write with the LIVE cell's id; the idle
  boundary is what makes the classification decidable;
- late text never appears in the next cell's result.

**What is NOT achieved:** a background write that lands during a LATER cell is
indistinguishable from that cell's own output, because the kernel stamps it with
that cell's id. A per-cell nonce cannot fix this without a second IOPub channel,
which the audit explicitly forbids. Recorded as an open gap, not papered over.

`tests.txt` → `requirement 9: late output is classified separately` (2 tests).

## 10. Bounded output — PASS

A cell printing ~200 MB (3200 × 64 KiB) with a 64 KiB cap returns `ok` with
`truncated: true`, `totalBytes > 200 MB`, and retained text bounded by the cap —
so the host's memory is bounded by the cap rather than by the cell. A spill file
is written and its size asserted `> 0`, so the loss is recoverable rather than
merely declared. A control test asserts an under-cap cell reports
`truncated: false`, so the flag is not always-on. A third asserts a 4 MB
`display_data` payload is bounded by its own cap, because a single MIME message
would otherwise bypass the stream cap entirely.

Two independent bounds: the per-cell stream cap in the broker, and
`MAX_FRAME_BYTES` (4 MiB) in the framing, which is checked against the DECLARED
length before the bytes are buffered — `protocol.test.ts` proves that ordering
with a header claiming more than the limit and no payload.

`tests.txt` → `requirement 10: a flooding cell cannot OOM the host` (3 tests) and
`bounded framing` (7 tests).

## 11. Kernel death changes the generation — PASS

The kernel is killed with `taskkill /F`. The next call reports
`outcome != ok` with `generation.volatileStateLost: true`,
`generation.previousEpoch` equal to the pre-kill epoch, and a higher
`generation.epoch`; the reason names the kernel log. A second test asserts the
replacement kernel is usable and EMPTY (`"marker_variable" in dir()` is `False`).

The submitted code is deliberately NOT re-run in the replacement kernel: doing so
would let a cell report success in a namespace that no longer holds the variables
it was written against, and that success would hide the loss.

`tests.txt` → `requirement 11: kernel death changes the generation` (2 tests).

## 12. ONE tool named `ipython`, one `code` parameter — PASS

`tests.txt` → `requirement 12` (2 tests): the registered definition has exactly
one parameter, `code`, required; and no lifecycle tool name
(`ipython_open`/`_send`/`_read`/`_status`/`_close`) is exported by or registered
in any file of the package.

**And it reaches the model through the REAL resolver**, which is a different and
stronger claim than "the plugin mounts". `qualification/runners/verify-ipython-e2e.mjs`
runs inside a real `dsh --profile daily` boot and reports:

```
kernelServicePresent: true
toolCountAgentKey: 28        ipythonToolPresent: true
ipythonParameterNames: ["code"]   ipythonIsOnlyParameter: true
forbiddenLifecycleTools: []  toolCountContextKey: 1
```

`ipython` is in the Session's model-facing catalog, with `code` as its only
parameter and no lifecycle tool beside it. See `e2e-tool.json`.

---

## The bundle defect: `ipython` would never have reached the model

The first version of this package compiled and passed 38/39 tests while being
**unloadable by any profile**. `package.json` declared no `dsh.bundle.patch` and
no `cordis.patch.yml` existed, so `dsh plugin add` installed it as a plain
dependency and activated **no layer**. The profile would boot with no kernel
service, the model would never see the tool, and every direct-mount test would
still pass.

This is the defect this project already recorded as **G-FIX-04**, whose lesson is
quoted in `docs/GAPS.md`: *"a gate whose oracle is weaker than its scenario will
pass while the product is broken."* `requirements.test.ts` mounts the plugin
directly, so it is exactly the weaker oracle the record warns about. Both are now
present, and the stronger one is what closes requirement 12.

Fixed by: `cordis.patch.yml` mounting the SERVICE at host level (the registry is a
process singleton keyed by Session, and a kernel outlives any one Agent
incarnation), the `ipython` TOOL row in an agent PRESET (a tool is agent-scoped;
a host-level tool row publishes into the root realm where no agent's scope sees
it), `dsh.bundle.patch` in `package.json`, and a compiled `lib/`.

The probe measures both scope keys on purpose. `tools.schemas(agent)` returns 28
tools; `tools.schemas(agent.ctx)` returns 1. The second is the false-negative
shape recorded as **G-FIX-06**, and recording both makes the contrast evidence
rather than folklore.

---

## The process-hygiene failure: a wrong oracle, not a leak

The first `cleanup.test.ts` compared raw `python.exe` pid SETS and failed with 2–3
"survivors". The coordinator correctly refused to let it be loosened. Diagnosis:

**The oracle was wrong.** This machine runs other agents' Python, including the
ZLoop bridge's own IPython kernel
(`E:\zcode-labs\zloop\plugin\runtime\...\bridge.py` → `ipykernel_launcher`).
Those processes start and stop on their own schedule, so a set diff reports "new
pids" this suite never created — indistinguishable from a leak by timing alone.
Checked by hand, the reported survivors' command lines were ZLoop's bridge and its
kernel, with a parent chain ending at a `bridge.py` pid that was already in the
BASELINE.

The three candidate explanations the coordinator listed were separated by
measurement, not by widening the window:

1. **Transient?** No — and not the cause here. Isolated: `leak-diagnostic.mts`
   records both the broker and the kernel gone **1069 ms** after `shutdown()`, and
   the `before`/`after` sets identical while idle (no drift).
2. **Bad baseline?** Partly. The ambient set genuinely changes mid-test because
   other agents start Python; a set diff cannot attribute that.
3. **Real leak?** **No.** A sampler over the whole suite attributed 60+ appearing
   pids by ANCESTRY (walking each process's parent chain to a `broker.py` in this
   package's directory) and found **zero** belonging to this package. A control arm
   with nothing of ours running reports zero over 30 s, so the classifier has no
   false positives.

The test now asserts the same property with an oracle that can distinguish the two
worlds: ancestry attribution, a control arm proving the classifier has teeth, an
assertion that a STARTED kernel IS found (so the walk is not vacuously empty), and
a bounded wait whose bound is itself asserted not to have been reached. A fifth
case kills the kernel out from under the host and asserts the replacement does not
leak — the case where a naive handle would strand the second kernel.

`tests.txt` → `process hygiene` (5 tests).

**Baseline vs post-run, as requested:** raw `python.exe` counts on this machine
were 13–16 during this work and are dominated by other agents. A raw count is not
evidence and is not presented as such; the before/after diff within the test,
attributed by ancestry, is.

---

## What is left open

1. **IPY-08 (natural activation end).** The registry is keyed by Session rather
   than Agent, and a test proves two different Agent objects on one Session reach
   one kernel. What is NOT exercised is a real continuable child ending an
   activation and a later one re-binding — that needs the subagent lifecycle and
   a model provider, and no model participated here.
2. **Requirement 9's undecidable case**, stated in full above.
3. **Requirement 8's await-suspended interrupt**, stated with the exact numbers.
4. **Native-tool callbacks from a cell** (the audit's separate bounded IPC). The
   broker has the transport for it — DSH's inherited control descriptor, verified
   working in both directions from Python — but no native tool is exposed to
   Python yet. That is M4/M5 work.
5. **Resource budgets** (RES-04/05/06: RSS, pids, parked kernels). Not addressed;
   the kernel is a child of the broker and inherits no explicit limit.
6. **The preset row is now version-controlled, but installing it is still a
   deployment step.** `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml`
   carries the `ipython-tool` row as a full preset template (added by the
   supervisor, superseding an earlier single-row fragment this agent had written
   at `profiles/daily-candidate/ipython-preset-row.yml`, which was removed as
   redundant once the full template existed). The row is the agent-plane half of
   this package and cannot live in the bundle patch: tools are agent-scoped, so a
   host-level tool row publishes into the root realm where no agent's scope sees
   it. What remains manual is the copy into
   `<DSH_HOME>/.agent-presets/`, which is a runtime directory — the same
   deployment shape the `work` tool already has (G-FIX-05). The probe in
   `e2e-tool.json` was taken against that runtime copy.
