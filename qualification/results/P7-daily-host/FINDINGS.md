# P7 — gate A12: the real daily Web host, full lifecycle

**Status: PARTIAL (strongly extended).** The recorded A12 partial result stopped
at the credential boundary with **no shutdown claim and no model turn**. This
round adds a **measured shutdown**, a **measured restart**, and a **model turn
driven through the real Web host without a live provider**. What remains
`BLOCKED_EXTERNAL` is only the live-provider turn, and it is named precisely at
the end.

Everything below is a measurement with an artifact behind it. Nothing here is
inferred from a comment.

---

## 1. What was run, and where

| Item | Value |
|---|---|
| Launcher (qualified built artifact) | `node /d/DSH/src/dsh-src/apps/cli/lib/bin.js` |
| Profile | `daily-candidate` (copy of the working installed profile) |
| `DSH_HOME` | `D:\DSH\home\canary12` (new; other canaries untouched) |
| Host port | **18912** (verified free before boot; see below) |
| Mock adapter port | **19411** |
| Boot cwd | `D:/DSH/src/dsh-src` |

**Port choice, and why 3080 was not used.** 3080 was **not** free: it was held by
another agent's host (`pid 41236`, `apps/cli/lib/bin.js --profile daily --patch
.../writers-mounted.patch.yml`). That process was left alone — it is another
agent's legitimate work. 18912 was checked against the listener table and
confirmed free before the boot; the runner records
`port_listening_before_boot: false` as part of its own transcript.

### Exact boot command

```sh
export DSH_HOME='D:\DSH\home\canary12'
cd /d/DSH/src/dsh-src
node apps/cli/lib/bin.js \
  --profile daily-candidate \
  --patch D:/DSH/work/dsh-native-daily/qualification/runners/verify-a12.patch.yml \
  -- --no-open --port 18912
```

`--no-open` is present, so no browser is launched. Note the **`--`**: `--patch`
is a *launcher* flag and must precede it. Putting `--patch` after the app's own
flags makes the Web app reject it (`error: unknown option '--patch'`), which was
observed on the first attempt and is why the command is written this way.

### Runner

```sh
node qualification/runners/verify-a12.mjs <outFile> --mock      # run1-mock.txt
node qualification/runners/verify-a12.mjs <outFile> --nomock    # run2-nomock.txt
```

Evidence files (all in `qualification/results/P7-daily-host/`):
`run1-mock.txt`, `run2-nomock.txt`, `signal-probe.txt`,
`inspect-session-log.mjs`.

---

## 2. Per-sub-claim status

| A12 sub-claim | Status | Measured value |
|---|---|---|
| The real launcher binds a real port | **PASS** | readiness line at 2174 ms; independent TCP connect `port_listening_after_boot: true` |
| Unauthenticated request refused | **PASS** | `unauthenticated_api_status: 401`, body `"unauthorized"` |
| Token URL → cookie → app shell | **PASS** | exchange `303` + `Set-Cookie`; authenticated `/` → `200`, body is the app shell |
| `session/create` + `session/list` round trip | **PASS** | created `session-e34a2e75-…`; found in `list` with `preset: daily-standard`, `permissions: workspace-write` |
| **Clean shutdown** | **PASS (measured)** | exit code **0**, **327 ms**, no port, no process, no data leftover |
| **Restart after shutdown** | **PASS (measured)** | second boot on the same port in 1854 ms; 401, 303, session list all re-established; **the session created in boot 1 was visible in boot 2** |
| Model turn through the host | **PASS on a controlled LOCAL route** | 2 mock requests, real `read` tool executed, `tool/call` + `tool/result` + final assistant text in the durable log |
| Model turn against a **live provider** | **BLOCKED_EXTERNAL** | see §7 |

---

## 3. Shutdown — the measurement the recorded result did not have

### Why a signal was not used

The recorded note said `child.kill('SIGTERM')` terminates the launcher instead of
running its handler, so no exit code was observed. That is a statement about the
driver, so it was measured on its own, on throwaway children, before being
applied to the host.

Probe: `qualification/runners/verify-a12-signal-probe.mjs` →
`signal-probe.txt`. Each trial starts a child that installs SIGINT/SIGBREAK/
SIGTERM/SIGHUP handlers and logs which one **fired**. A trial is catchable only
if the child's own log records a caught signal.

```
A  child.kill('SIGTERM')                       caught=[]         catchable=false
B  process.kill(pid, 'SIGINT')                 caught=[]         catchable=false
C  CTRL_C_EVENT on the child's own console     caught=[]         catchable=false
D  CTRL_BREAK_EVENT on the child's console     caught=[SIGBREAK] catchable=TRUE
E  CTRL_C_EVENT through a cmd.exe group root   caught=[]         catchable=false
```

A and B confirm the recorded note. C and E show CTRL_C is not deliverable here:
a `CREATE_NEW_CONSOLE` process is a process-group root and CTRL_C is disabled for
a group root, and routing through a `cmd.exe` root did not change that. **D is
the only catchable route**, and Node surfaces `CTRL_BREAK_EVENT` as `SIGBREAK`.

The launcher registers handlers for **SIGTERM and SIGINT only**
(`apps/cli/src/profile-boot.ts`), and nothing in `apps/` or `packages/` registers
SIGBREAK. The Web profile also mounts no in-product exit command: `exitOnStdinEnd`
is bound by the acp and sdk apps only, and a piped stdin that is never resumed
does not emit `end` (measured). **So on win32 this host has no product-reachable
graceful-stop route at all.** That is a real, platform-level finding, recorded
separately in `qualification/results/M0.6-launcher-identity/A12-launcher-shutdown-identity.txt`.

### How shutdown was therefore measured, and how it is labelled

`qualification/runners/verify-a12-shutdown-route.mjs` (mounted only by this
gate's own `--patch` overlay) adds one route, `POST /a12/shutdown`, which:

- calls the launcher's **own** `ctx.appExit` — the same bounded-exit callback the
  product's `exitOnStdinEnd` calls — so the **production dispose path runs**
  (refuse admissions → stop owned work → release storage → unwind the context →
  exit); and
- reuses the product's **real** browser-trust fence via
  `ctx.connection.requestRejection`, so an unauthenticated caller gets the same
  401 as every other `/api` route. No auth was invented and no permission widened.

**This is a qualification instrument, not a product change.** The runner records
`shutdown_trigger_is_product_route: false` and
`shutdown_path_is_production: true` on every run so the transcript cannot be read
as a product route existing.

### Result (both runs)

| Metric | run1 (mock) | run2 (no-mock) |
|---|---|---|
| `process_exited` | true | true |
| `exit_code` | **0** | **0** |
| `exit_signal` | null | null |
| `shutdown_ms` | **327** | **351** |
| `restart_exit_code` | **0** | **0** |

Exit code 0 with no signal means the launcher's `shutdown.shutdown(0)` path
completed: disposal quiesced well inside the 5 s grace
(`PROCESS_SHUTDOWN_TIMEOUT_MS`), and the force-exit timer never fired.

The route's own HTTP response is `socket-closed-before-response` / `"fetch
failed"` — **expected, not a failure**: the host disposes the server that is
answering the request. The runner records that transport error as a value rather
than throwing, and the exit code above is the real outcome.

### What was looked for to detect leftovers, and how

Each check is an independent observation, not a restatement of the host's log:

1. **Listening socket** — a fresh TCP connect to 18912 after exit.
   `port_listening_after_shutdown: false` (both runs).
2. **Descendant processes** — a WMI query for node processes whose command line
   names this run's home or port, taken **before** shutdown and again **after**.
   `pids_before_shutdown: [47968]` → `pids_after_shutdown: []`.
   `descendant_process_left_behind: false`.
3. **Temp directory, attributed rather than merely listed.** The temp root is
   snapshotted **before** the boot and diffed after, because a bare list of
   `dsh-*` matches is not evidence — other agents' runs match the same pattern
   (434 matches existed at measurement time). The diff isolates what *this* run
   created. Result: one new entry, `dsh-spill-<id>`, containing **0 files, 0
   bytes**.
4. **Durable state** — the storage domain and session logs are inspected for a
   leaked handle or a still-growing log. The session log is a clean 9-frame
   concatenated-zstd file with `tornStart: none`.

**One honest nuance, stated rather than hidden.** The `dsh-spill-<id>` root does
survive the process. It is **empty**, and that is by design rather than a leak:
`packages/spill/spill-local/src/index.ts` creates a lazily-created private
per-process root under the OS temp dir and reclaims it with a **startup** sweep
after `cleanupPeriodDays` (default 30). So the retention is the documented
contract, and no spilled data survived — the mock run's `read` result was small
enough never to spill. This is reported as an empty-directory residue, **not** as
a data leak. (For contrast, other `dsh-spill-*` roots on this machine from other
agents' runs do hold 64 KB `pwsh.txt` files, which is what a real spill looks
like.)

**No claim is made about the 5 s forced-exit path** — it never triggered, so its
behaviour is unmeasured here.

---

## 4. Restart after shutdown

The second boot reuses the **same port**, which is the point: a host that cannot
rebind has not really released its socket.

| Metric | Value |
|---|---|
| `restart_boot_succeeded` | true |
| `restart_ready_line_ms` | 1854 ms |
| `restart_port_listening` | true |
| `restart_unauthenticated_api_status` | 401 |
| `restart_token_exchange_status` | 303 |
| `restart_session_list_ok` | true |
| **`restart_sees_session_from_first_boot`** | **true** |
| `restart_process_exited` / `restart_exit_code` | true / **0** |
| `restart_port_listening_after_shutdown` | false |

The persisted session created during boot 1 was listed by boot 2, so shutdown
released storage without discarding it, and the second host is genuinely
functional rather than merely listening.

---

## 5. A model turn WITHOUT a live provider — achieved

**Yes.** A model turn was driven through the real Web host, with no provider key
and no paid budget, using the **in-tree mock adapter** at
`packages/test-support/llm-mock-server` (built `lib/index.js`, imported directly).

Exact mechanism: `verify-a12.patch.yml` points the **real** `llm-deepseek`
adapter at the mock's OpenAI-compatible endpoint
(`baseURL: http://127.0.0.1:19411`, `protocol: chat-completions`) and names the
credential reference `A12_MOCK_KEY`, so the mock's token travels the **real
credential path** instead of around it. The adapter, the HTTP transport, the
AgentLoop, the tool registry and the Session log are all the real ones.

The prompt (`POST /api/session/prompt` → `{accepted: true}`) was:

> `Read the first lines of AGENTS.md, then report what you read.`

The prompt deliberately **does not contain** the marker string. If it did, the
user message echoed into the log would match a substring search and a turn that
never ran would look successful. The marker is supplied **only** by the mock's
scripted assistant text, and the check requires it inside an
**`assistant/message`** record — so the reply must be model-produced.

Result, from the durable session log (not from a UI frame):

```
session_prompt_ok: true
model_turn_tool_call_event: true
model_turn_tool_result_event: true
model_turn_tool_result_carries_file_content: true
model_turn_final_text_seen: true
model_turn_run: true
session_log_frames_total: 9
session_log_torn_tail: none
session_log_event_types: {"session":1,"permission/preset":1,"sandbox/mode":1,
  "approval/policy":1,"agent/inbox/spliced":2,"turn/start":1,"step/start":2,
  "system/message":1,"user/message":3,"request/header":1,"request/context":1,
  "session/title":1,"session-log-deepseek/delivery-accepted":2,
  "assistant/message":2,"tool/call":1,"tool/result":1,"step/end":2}

mock_requests_accepted: 2
  mock_request_1: behavior=tool_call_success path=/chat/completions outcome=completed
    tool_catalog_count: 28   has_read_tool: true   has_work_tool: true
  mock_request_2: behavior=success path=/chat/completions outcome=completed
    assistant_tool_calls_in_history: ["read"]
    message_roles: ["system","user","user","user","assistant","tool"]
    tool_catalog_count: 28   has_read_tool: true   has_work_tool: true
```

The final assistant record:

```json
{"type":"assistant/message","data":{"turn":1,"step":2,"message":{"role":"assistant",
 "content":[{"type":"text","text":"A12_MOCK_TURN_COMPLETE"}],
 "source":{"kind":"model","provider":"deepseek-official","model":"deepseek-flash"}},
 "usage":{"inputTokens":3,"outputTokens":22,"totalTokens":25}}}
```

So the host's **turn path is qualified**: two real HTTP round trips, a real tool
call to the real `read` tool, the tool result carried back into the second
request (`assistant_tool_calls_in_history: ["read"]`), and a model-produced final
message persisted to a clean zstd log. The offered catalog carried **28 tools**
including both `read` and the extension's **`work`** tool.

**This is a controlled LOCAL route, not a live provider.** It proves the host can
drive a model turn; it does **not** prove anything about DeepSeek's real API,
its auth, its rate limits, or its streaming fidelity.

### One instrument choice, disclosed

`session-title-llm` is disabled by the overlay. It is a **second, independent
consumer** of the same model route, so leaving it enabled makes the mock's FIFO
script depend on which consumer wins the race. The product's own Web e2e scaffold
disables the same row for the same reason (`apps/web/tests/scaffold.ts`). The
turn path is what is under test; the deterministic fallback title is still
produced.

---

## 6. The credential boundary, re-established on the STOCK route

`run2-nomock.txt` boots with an overlay carrying **only** the shutdown
instrument, so the provider endpoint stays stock and the failure measured is the
credential failure itself. (Measuring it on the mock overlay would have produced
a connection or auth failure wearing the name `MISSING_CREDENTIAL`.)

```
credentials_file_exists: true
credentials_file_record_keys: ["client-connection/browser-session","kind","payload","version","secret"]
credentials_file_has_refs_section: false
cwd_env_exists: false
home_env_exists: false
deepseek_api_key_in_process_env: false
deepseek_api_key_in_invocation_env: false
boundary_prompt_rpc_ok: true
boundary_missing_credential_seen_in_session_log: true
```

The exact durable record (`turn/end`), quoted from the log:

```
llm-deepseek: no API key for provider route "deepseek-official"; store
DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
  code: MISSING_CREDENTIAL
```

This confirms the boundary is **CREDENTIAL**, not composition: the host booted,
accepted the prompt, built a real request, and stopped at the key.

No key was read, printed, or exported. `.credentials.yaml` was inspected for
**key names only**; no value is reproduced anywhere in this evidence.

---

## 7. What is NOT proven

1. **A live-provider model turn.** `BLOCKED_EXTERNAL`, with the exact field:

   ```
   compatibility.lock.json → runtime_authorization.live_provider_budget_authorized: false
   ```

   No live provider was called, and no paid budget was consumed. A key being
   present on the machine does not authorize paid evaluation, so none was used.
2. **The launcher's SIGTERM/SIGINT handlers.** They exist in source but could not
   be exercised, because win32 cannot deliver either catchably (probe rows A–C,
   E). The measured exit code 0 came from `ctx.appExit`, which is the **same
   bounded shutdown** those handlers call — but the signal handlers themselves
   remain unexercised on this platform.
3. **The 5 s forced-exit path** in `createProcessShutdown`. Disposal took ~0.3 s,
   so the timeout never fired.
4. **Graceful shutdown through a product-reachable route.** None exists on win32
   (see §3). The instrument route is a gate artifact, not a shipped capability.
5. **Sustained/long-running behaviour.** This measured a boot, one turn, one
   shutdown, one restart. No soak, no concurrency, no multi-session load.
6. **Non-win32 shutdown.** Everything about signal delivery here is win32-specific;
   POSIX `SIGTERM` may well reach the handler.
7. **The `dsh-spill` retention window.** The root survives shutdown by documented
   design; the 30-day startup sweep was not waited for.
8. **Anything about the source launcher.** A03 already established it is not
   equivalent; A12 used the built artifact only.

---

## 8. Proposed A12 row for `qualification/gates.json`

`docs/GAPS.md` and `qualification/gates.json` were **not** edited (per the task's
ownership rules). This is the row requested instead:

```json
{
  "id": "A12",
  "name": "the real daily Web host",
  "status": "PARTIAL",
  "summary": "The real built launcher boots the real daily composition as a long-lived Web host and completes a full lifecycle: port bind, 401 fence, token->cookie->200 app shell, session/create + session/list round trip, a model turn, a measured clean shutdown, and a restart on the same port. The model turn ran on a controlled LOCAL route (the in-tree mock adapter pointed at the real DeepSeek adapter), not a live provider.",
  "proven": [
    "boot: readiness line at 2174 ms on port 18912, confirmed by an independent TCP connect",
    "fence: unauthenticated POST /api/session/list -> 401 'unauthorized'",
    "auth: token URL -> 303 + Set-Cookie -> authenticated / -> 200 app shell",
    "session: session/create then session/list round trip; preset daily-standard, permissions workspace-write",
    "turn (LOCAL ROUTE): session/prompt accepted; 2 real HTTP requests to the in-tree mock adapter; real read tool executed; tool/call + tool/result + model-produced assistant/message persisted to a 9-frame zstd log with no torn tail; offered catalog carried 28 tools including read and work",
    "shutdown: exit code 0 in 327 ms, no listening socket, no descendant process, no spilled data (one empty dsh-spill root remains, which is the documented startup-swept design)",
    "restart: second boot on the same port in 1854 ms; 401, 303 and session list re-established; the session from boot 1 was visible in boot 2; second shutdown also exit 0",
    "credential boundary measured on the STOCK route: turn/end carries MISSING_CREDENTIAL, with DEEPSEEK_API_KEY absent from every layered source"
  ],
  "not_proven": [
    "a live-provider model turn",
    "the launcher's own SIGTERM/SIGINT handlers (undeliverable catchably on win32)",
    "the 5 s forced-exit path",
    "graceful shutdown through a product-reachable route (none exists on win32; the measurement used a gate instrument calling ctx.appExit)",
    "sustained load, soak, or concurrency",
    "non-win32 signal delivery"
  ],
  "blocked_external": {
    "field": "compatibility.lock.json -> runtime_authorization.live_provider_budget_authorized",
    "value": false,
    "reason": "A live-provider turn needs paid budget, which is not authorized. The mock-driven turn qualifies the host's turn path without it."
  },
  "evidence": [
    "qualification/results/P7-daily-host/FINDINGS.md",
    "qualification/results/P7-daily-host/run1-mock.txt",
    "qualification/results/P7-daily-host/run2-nomock.txt",
    "qualification/results/P7-daily-host/signal-probe.txt",
    "qualification/results/M0.6-launcher-identity/A12-launcher-shutdown-identity.txt"
  ]
}
```

---

## 9. Problems found outside this gate's ownership (reported, not fixed)

1. **No graceful-stop route on the Web host (win32).** The launcher registers
   SIGTERM/SIGINT only, neither of which win32 can deliver catchably, and nothing
   handles SIGBREAK, the one event that does arrive. The Web profile mounts no
   in-product exit command. For a host explicitly intended as a long-lived daily
   driver, an operator has no supported way to ask it to stop. Reported in
   `M0.6-launcher-identity/A12-launcher-shutdown-identity.txt`; **not** patched,
   because `apps/**` and `packages/**/src/**` are outside this gate's ownership.
2. **`--patch` ordering is a silent trap.** `--patch` is a launcher flag; placing
   it after the app's flags makes the app reject the whole invocation with
   `error: unknown option '--patch'`. The failure is loud, which is good, but the
   `--` separator is not mentioned in the launcher's own help text.
3. **`session/prompt` args envelope.** The RPC requires `{ request: {...} }`;
   passing the fields flat is rejected with
   `gateway/arguments-invalid ... missing "request"`. Correct behaviour, but the
   error is the only documentation encountered.

None of these were modified. `docs/GAPS.md`, `qualification/gates.json`,
`profiles/**`, and everything under `packages/**/src/**` are untouched.
