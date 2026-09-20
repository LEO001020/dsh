# P8 / STEP 1 — SOURCE MAP FOR THE HIDDEN-BIND SLICE

Measured on `D:\DSH\work\wt-p8` (branch `wt/p8`), before any edit.
Pinned ipykernel in this environment: **7.3.0**, CPython **3.14.3**, Node **v24.18.0**.
Python executable measured: `C:/Users/hzq00/AppData/Local/Programs/Python/Python314/python.exe`.

---

## 1. `runCell` — exact structure, and where the preamble decision is

`packages/dsh-ipython/src/kernel-plugin.ts`

| what | line |
|---|---|
| `runCell(agent, code, signal?, authority?)` declaration | **579** |
| `entryFor(agent)` / abort check | 580–583 |
| **authority-less early return** (no bridge, "preamble is not prepended") | **584–591** |
| `mintCellLease` + `entry.bridge.leases.add(lease)` | 593–594 |
| **THE PREAMBLE DECISION** | **595–597** |
| `entry.host.execute(dispatched, …)` | 601 |
| `finally`: `lease.close('completed', …)`, ledger-failure capture, `releaseLease` | 602–621 |
| generation notice + return | 622–625 |

The decision itself, verbatim (`:595-597`):

```ts
const dispatched = canPrependPreamble(code)
  ? [entry.bridge.server.preamble(lease), code].join('\n')
  : code
```

Supporting definitions:

| symbol | file:line | note |
|---|---|---|
| `canPrependPreamble` import | `kernel-plugin.ts:82` | imported from `./bridge.ts` |
| `canPrependPreamble(code)` | `bridge.ts:1307-1314` | scans raw source for the first non-blank line; returns `false` iff it starts with `%%` |
| `renderBridgePreamble(input)` | `bridge.ts:1282-1298` | 11-line Python string; ends with `dsh = _dsh_mod` and a `del` of its own temporaries |
| `BridgeServer.preamble(lease)` | `bridge.ts:1019-1029` | fills `clientPath/port/token/leaseId/cellId/epoch` |
| `BridgePreambleInput` | `bridge.ts:1254-1261` | `clientPath, port, token, leaseId, cellId, epoch` |
| `mintCellLease` | `kernel-plugin.ts:642-673` | mints the `CellLease` with the handler built from `createNativeCallHandler` |
| `CellAuthority` | `kernel-plugin.ts:220-237` | `callId, rootCallId, token, agent, cellId, onContext?, onConcludeTurn?, onImageRetained?` |

`canPrependPreamble` has exactly one caller: `kernel-plugin.ts:595`.
(`bridge-seam.test.ts` and the `v4-*`/`t7` probes call `b.preamble(lease)` by hand; they are not
production callers, and `bridge-seam.test.ts`'s own guard keeps a named probe list for this reason.)

---

## 2. The execute_request / reply / idle exchange on this path TODAY

**YES — the current code already waits for a matching `idle`, and the match is by parent id.**
The hidden-bind design does not need a second wait mechanism; it reuses this one.

The path is three layers, and the wait lives in the bottom one:

1. **Host** — `packages/dsh-ipython/src/kernel.ts:471-510`, `KernelHost.execute(code, options)`:
   - refuses with `KernelBusyError` if `this.cellActive` (`:474-476`) — **one active cell per kernel**, so a
     hidden bind cannot interleave with a user cell;
   - sends `op: 'execute'` with **only** `{ code, outputCapBytes?, timeoutMs, interruptGraceMs }` (`:486-498`);
   - the host-side timeout is `cellTimeout + grace + 60_000`, deliberately longer than the broker's own
     budget so the broker's classification wins (`:494-497`).

2. **Broker request loop** — `packages/dsh-ipython/src/broker.py:1294-1316` dispatches `op == "execute"`
   onto a worker thread (`:1297-1304`), so an interrupt arriving during a cell is still read.

3. **Broker cell body** — `Broker.execute`, `broker.py:887-978`:
   - reads `code` (`:896`), `outputCapBytes` (`:899`), `timeoutMs` (`:925`), `interruptGraceMs` (`:928`);
   - constructs the `execute_request` at **`:909-919`**;
   - registers the shell waiter **BEFORE** sending (`:934`), then `shell_channel.send(msg)` (`:935`);
   - the settle loop at **`:936-953`**:

     ```python
     if reply is None:
         reply = router.take(msg_id)
     if reply is not None and sink.idle_seen:
         break
     ```

     i.e. it breaks only on **reply AND idle**, and reports `unknown` if the pair never arrives
     (`:955-961`). `_finish` (`:980+`) turns `reply.content.status` into `ok` / `error` / `aborted` /
     `interrupted`.

   - **idle matching is parent-filtered**: `_route_iopub` (`broker.py:812-836`) absorbs an IOPub frame only
     when `parent == sink.msg_id and not sink.idle_seen`; `CellSink.absorb` (`:451-473`) sets
     `idle_seen = True` on `msg_type == "status"` with `execution_state == "idle"`. A frame for another
     request is counted, never delivered (the `foreignFrames` counter, `:969`, surfaced to the model at
     `ipython-tool.ts:131-136`).

   - the shell side is a single reader with register-before-send: `ShellRouter.register` (`:540-545`),
     `.take` (`:547-550`), `.release` (`:552-555`); `_shell_request` (`:858-883`) is the generic
     one-reply path and is what `status`/`kernel_info`/`restart`/`interrupt` use. **`_shell_request` does
     NOT wait for idle** — only the `execute` path does.

---

## 3. `execute_request` construction: which fields exist, which must be added

Constructed at `broker.py:909-919`:

```python
msg = self._kc.session.msg(
    "execute_request",
    {
        "code": code,
        "silent": False,
        "store_history": True,
        "user_expressions": {},
        "allow_stdin": False,
        "stop_on_error": True,
    },
)
```

**`silent`, `store_history` and `allow_stdin` are HARDCODED LITERALS — they are not parameters of the
host↔broker request today.** `BrokerRequest` (`protocol.ts:152-165`) carries only
`id, op, code?, cellId?, outputCapBytes?, timeoutMs?, interruptGraceMs?`.

So the hidden-bind slice needs a **host→broker pass-through** for at least `silent` and `store_history`.
`allow_stdin: False` is already the correct and only value here (`broker.py:903-904` records why:
`input()`/`getpass()` must fail immediately rather than park the cell on a terminal read).

### Kernel-side semantics these flags have (SOURCE_FACT, read from the installed 7.3.0)

- `kernelbase.py:793-794` — `silent = content.get("silent", False)`;
  `store_history = content.get("store_history", not silent)`.
- `kernelbase.py:810-817` — when `silent`, the execution counter is **not** incremented and
  `_publish_execute_input` is **not** called; `silent` is forwarded to `do_execute`.
- `ipykernel/ipkernel.py:461` — `run_cell(code, store_history=…, silent=silent, …)`.
- `IPython/core/interactiveshell.py:3389-3390` — **`if silent: store_history = False`** (silent forces it).
- `:3209` / `:3411` / `:3427` — `pre_run_cell` and `post_run_cell` events are skipped when `silent`.
- `:3471` — `interactivity = "none" if silent else self.ast_node_interactivity`, so a silent cell emits no
  `execute_result` for a trailing expression.
- `kernelbase.py:868` — **`if not silent and reply.status == "error" and stop_on_error: self._abort_queues(...)`**.
  A silent request that errors therefore does **not** abort the kernel's queues. This is a real advantage
  for a hidden bind: a failed bind must not poison the user cell that follows.

Two consequences that matter for the design and are easy to get wrong:

1. `silent=True` **does** still publish `status: busy` / `status: idle` on IOPub and **does** still produce a
   matching `execute_reply` (`kernelbase.py:429`, `:449`, `:462`). So the broker's existing
   reply+idle settle condition still completes for a silent request — **the hidden phase can reuse
   `KernelHost.execute` unchanged in its waiting behaviour.**
2. `silent=True` means the hidden bind **does not appear in IPython's input history**
   (`store_history` is forced false), which is exactly what keeps the source-identity oracle clean: the
   user cell remains `input_hist_raw[-1]`.

---

## 4. What the BEFORE probe measured (reproduction archived before any edit)

Instrument: `packages/dsh-ipython/src/p8-bind-probe.ts`
Output: `qualification/results/P8-bind/before.json`
Real ipykernel 7.3.0 through the real broker; cells driven through the **real model-facing `ipython`
tool** via `ctx.tools.execute` (the same registration the preset loads).

| observation | BEFORE |
|---|---|
| bytes the model submitted vs bytes IPython recorded | **NOT EQUAL** — `f83a15f9…` vs `d2f187b5…`; the recorded source is the 11-line preamble followed by the user's source |
| traceback line for a raise on user line 3 | reported **line 15** |
| SyntaxError line for an error on user line 3 | reported **line 15** |
| `%%capture` cell | **no preamble** (`canPrependPreamble` false); `dsh` inside it is the object left by the PREVIOUS cell, i.e. a lease that has already settled |
| `dsh` reachable in an authority-less internal cell | **YES** — `dsh_in_dir: true`, `import: OK`; the surviving object still carries the old lease id, and a call through it returns `LEASE_UNKNOWN` |
| `%who` | runs; lists `dsh` among the names |
| top-level `await` | works (`AWAIT=7`) |
| lease id per cell | differs across two ordinary cells |

**The pre-fix comment at `kernel-plugin.ts:585-587` claims `dsh` "does not exist in the namespace" for an
authority-less cell. Measured: it DOES exist whenever a prior bridged cell ran in the same persistent
namespace.** The stale object is refused by the server (`LEASE_UNKNOWN`), so this is not a privilege
escalation — it is a capability-lifecycle defect: the model can hold and call an object whose lease is
dead, and the error it gets does not explain that.

### One BEFORE finding that is NOT part of this slice

A `%%capture` cell containing a top-level `await` fails with
`RuntimeError: This event loop is already running` (`asyncio/base_events.py:631`, reached from
`run_until_complete`). This is **independent of the preamble** — it is IPython's nested-`run_cell`
behaviour inside a cell magic while ipykernel's loop is already running. It is recorded here so the
magic arm of the post-fix test uses a **sync** body for "does the magic run", and asks the binding
question separately, rather than attributing this to the bind path. Root cause of this specific failure
is **UNKNOWN** and is not claimed.
