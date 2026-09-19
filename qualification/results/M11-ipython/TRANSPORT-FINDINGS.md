# M0 addendum — the kernel transport question, answered by measurement

This note corrects and completes the transport item raised in
`M10.0-audit-repro/FINDINGS.md` §5. That section recorded that the default
`jupyter_client` start path emits

```
[IPKernelApp] WARNING | Kernel is running over TCP without encryption.
```

and called for M3 to obtain a non-plaintext transport. The probe results below
answer which transports are actually available **on this machine**, and one of
them required abandoning the audit's own first preference.

## Result

| Transport | Outcome | Connection file | Encrypted | Verdict |
|---|---|---|---|---|
| `transport='ipc'` | **FAILS** | — | — | `ZMQError: Protocol not supported (addr='ipc://kernel-ipc-4')` |
| `transport_encryption='required'` | works | `transport: tcp` + curve keys | **yes** | usable |
| `transport_encryption='auto'` | works | `transport: tcp` + curve keys | **yes** | usable |
| default (control) | works | `transport: tcp`, **no curve keys** | **no** | the unsafe baseline |

Evidence: `transport-probe.json`, `mechanics.json`.

### The audit's first choice is impossible on Windows

`transport='ipc'` fails at socket creation, before any kernel starts: Windows
libzmq is built without IPC support. This matters because the architecture
document lists IPC as the preferred transport. On this platform it is not an
option, and a design that assumes it would fail at the first `KernelManager`
construction.

### CurveZMQ is available, and it is what actually removes the warning

`transport_encryption='required'` yields a connection file carrying
`curve_publickey` and `curve_secretkey`, and `mechanics.json` records
`kernel_stderr_has_plaintext_warning: false` — the warning that M0 measured on
the default path **does not appear**. So the plaintext exposure is closed by
manager-provisioned CurveZMQ keys, which is the audit's second option.

The kernelspec corroborates the intent: `supported_encryption: curve`.

This also revises the M0 note's framing. The warning is not evidence that
jupyter_client cannot encrypt; it is evidence that the *default* path does not,
and that a caller who does not ask for encryption silently gets none.

### A correlation defect in the `required` mode — RESOLVED, not a defect

`transport-probe.json` recorded `reply_msg_id_matches: false` for
`transport_encryption='required'`, while `'auto'` and the default both matched.
A shell reply whose `parent_header.msg_id` does not match the request is exactly
the condition IPY-06 says must not be able to complete a cell, so this was
recorded as an open question rather than dismissed.

`probe-correlation.py` repeated the sequence 5 times in all three modes and
recorded every reply's parent id. **The mismatch is present in ALL THREE modes,
including the unencrypted default:**

```
default:        curve=False matched=4/5
curve_required: curve=True  matched=4/5
curve_auto:     curve=True  matched=4/5
```

And the single mismatch in each mode has the same shape:

```
request:         ..._36856_2      (execute_request)
first reply:     kernel_info_reply, parent ..._36856_1
next on channel: execute_reply,     parent ..._36856_2   <- the real answer
```

So it is not an encryption problem at all. `wait_for_ready` sends a
`kernel_info_request`, and its reply can still be queued on the shell channel
when the first `execute` is issued; a consumer that takes the first shell message
reads that leftover frame. The reply for the actual request arrives next, with
the correct parent.

**Conclusion: encryption and cell attribution are NOT in tension.** `required`
mode is safe to adopt, and `reply_msg_id_matches: false` in the earlier probe was
a measurement artefact of reading one message without filtering.

The episode is worth keeping in the record because it establishes a requirement
the implementation must honour: **the reader MUST filter by `parent_header.msg_id`
and must not treat "the next shell message" as "the answer".** That is IPY-06, and
this is the concrete reason it is not optional — a real stray frame exists on
every kernel start, so the naive reader is wrong immediately rather than rarely.


## Consequences for M3

1. Start kernels with **`transport_encryption='required'`**, never the default.
   Assert the curve keys are present in the connection file and that the plaintext
   warning is absent — a test, not a convention, because the failure mode is
   silent.
2. Do not attempt IPC on Windows. A cross-platform start path must select the
   transport by capability rather than assuming the POSIX answer.
3. **Filter shell replies by `parent_header.msg_id`.** A stray `kernel_info_reply`
   is queued on the shell channel at every kernel start, so "read the next shell
   message" is wrong on the first cell of every kernel, not merely under a rare
   race. This is IPY-06 and it is now backed by a reproduced frame.

## Other mechanics confirmed by the same probes

- **Real IPython with top-level await**: `ZMQInteractiveShell` with `%time`
  working, and a bare `await` in the cell body returning a value. The audit's
  claim that no async-function-body wrapper is needed is confirmed.
- **`stdin` is disabled**: `input()` raises `StdinNotImplementedError` rather than
  hanging, so a cell cannot wedge waiting on a terminal.
- **A CPU loop interrupts correctly**: `KeyboardInterrupt` reported after 1.8 s,
  and a subsequent cell reuses the kernel.
- **Late thread output is attributable**: output written by a background thread
  after the cell settled still carries the ORIGINATING cell's `parent_msg_id`, so
  it can be classified as late rather than being attached to the next cell. The
  audit's requirement is satisfiable without inventing a second channel.

## A case that does NOT settle: interrupting an await-suspended cell

`cases.json` records `interrupt_await_suspended`:

```
settled: false            after 20.15 s
second_interrupt_settled: false   after a further 10.07 s
process_alive_after: true
```

Interrupting a cell suspended in `await` did not produce a reply after two
interrupts and 30 seconds, while the kernel process stayed alive. The CPU-loop
case interrupts in 1.8 s, so this is specific to the await-suspended state.

This is a real finding with a direct product consequence: the audit's IPY-07
requires that "when the outcome cannot be established, report `unknown` and
reset". A design that instead waits for a reply would hang a model turn
indefinitely. M3 must therefore treat an interrupt that does not settle within a
bounded grace as `unknown` + kernel restart, and must test that path — the
non-settling case is reachable, not hypothetical.

## Scope

These are **kernel-mechanics probes**. No DSH tool, no DSH session and no LLM
participated, so they are not evidence for any DSH integration or data-plane
gate. They establish which transport and lifecycle behaviours M3 can rely on.
