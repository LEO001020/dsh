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

### A correlation defect in the `required` mode

`transport-probe.json` records `reply_msg_id_matches: false` for
`transport_encryption='required'`, while `'auto'` and the default both match.
A shell reply whose `parent_header.msg_id` does not match the request is exactly
the condition IPY-06 says must not be able to complete a cell.

This is **not** yet a confirmed product defect: it is one observation from a
probe that does not control message ordering. It is recorded as an open question
that M3's implementation must answer with a deliberate test, because if `required`
genuinely breaks correlation then encryption and correct cell attribution are in
tension and the choice must be made explicitly rather than discovered later.

## Consequences for M3

1. Start kernels with **`transport_encryption='required'`** (or `'auto'`), never
   the default. Assert the curve keys are present in the connection file and that
   the plaintext warning is absent — a test, not a convention, because the
   failure mode is silent.
2. Do not attempt IPC on Windows. A cross-platform start path must select the
   transport by capability rather than assuming the POSIX answer.
3. Resolve the `required`-mode correlation question before relying on that mode.

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
