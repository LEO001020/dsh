# M9.3 — denial fixtures for E01, E03, E06

**Date:** 2026-09-19
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)
**Runner selected:** `windows-acl` (the sole `win32` candidate), enforcement `partial`
**Evidence:** `tests.txt` (16 passed), `tsc.txt`, `source-digests.txt`, and
`packages/dsh-daily-work/src/security-denial.test.ts` (digest recorded).

## Verdict summary

| gate | was | now | why |
|---|---|---|---|
| **E01** credential isolation | NOT_RUN | **NOT_RUN — CANNOT BE CLOSED ON WINDOWS** | The boundary that exists is a WRITE boundary. A read of a file outside the workspace root SUCCEEDS under every confined mode. The gate's oracle is a read claim; there is no mechanism to satisfy it here. |
| **E03** permission change with a live PTY | NOT_RUN | **PASS** (with a stated reach limit) | The fence was exercised against a REAL confined PTY and refuses the change; the refusal is total (no event logged, resolved mode unchanged). Reach limit: the fence is only reachable under `workspace-write`, because under `read-only` no PTY can start at all. |
| **E06** network egress | NOT_RUN | **FAIL — no egress control exists** | A confined child completes a real HTTP round trip to a loopback server and connects to a public address. The gate's oracle is "an external boundary intercepts". Observation contradicts it. Recorded as FAIL, not NOT_RUN: the absence is now a demonstrated fact, not an untested assumption. |

The previous notes on these gates said "no designed fixture". The fixture now
exists. Two of the three gates resolve to the negative, and that is the result —
the fixtures were built to find out, not to confirm.

---

## E01 — credential isolation: the boundary is writes, not reads

### What was done

`qualification/fixtures/canary/` holds a fabricated canary secret at
`outside/canary-secret.txt` and a harmless marker at
`workspace/canary-marker.txt`. `outside/` is a SIBLING of `workspace/`, never a
child, so it sits on the far side of the only boundary `workspace-write` draws.
The fixture is copied to a fresh temp directory per run (see "Safety" below).

The test mounts the REAL `LocalSandboxProvider`, calls the REAL
`ctx.sandbox.confine()`, and then runs the confined argv through the REAL
`ctx.subprocess.spawn()` — the exact composition `@deepseek-ai/dsh-bash-sandbox`
uses (`src/index.ts`: `this.ctx.sandbox.confine(...)` then `startArgv` →
`this.ctx.subprocess.spawn(...)`).

### What was observed

| effect | `read-only` | `workspace-write` |
|---|---|---|
| read a file OUTSIDE the workspace | **ALLOWED** | **ALLOWED** |
| read a file INSIDE the workspace | allowed | allowed |
| write a file OUTSIDE the workspace | denied `EPERM` | denied `EPERM` |
| write a file INSIDE the workspace | denied `EPERM` | **allowed** |

The confined child exited 0 and returned the canary secret verbatim. No denial
signature appeared on stderr, so this is a genuine read, not a denial misread as
success. The full four-way matrix is asserted in one test so the negative
finding is precise rather than "the sandbox does nothing".

### Why this is structural, not a bug in this project

`@deepseek-ai/dsh-sandbox-windows-acl/src/index.ts` states the boundary in its
own header: "writes are restricted; reads, network, and process visibility are
NOT (WRITE_RESTRICTED intersects only write accesses)". The mechanism is a
restricted token whose restricting-SID list intersects only write accesses, so a
read is not merely un-denied — it is outside the mechanism entirely.

The seam cannot express a read policy either. `SandboxPolicy` is
`mode` + `workspaceRoot` (+ `sessionId`); `confine()` returns exactly
`argv`/`enforcement`/`denialSignatures`/`runnerFailureRules`. There is no field a
caller could set to restrict reads. Both facts are asserted, so a future change
that adds a read lever would be visible.

`enforcement: 'partial'` is the backend's own honest report of this. It is
asserted literally, so if the claim changes, the test fails and this finding must
be revisited.

### The one credential control that does exist — and what it is not

`@deepseek-ai/dsh-subprocess` drops credential-SHAPED names
(`/KEY|PASSWORD|SECRET|TOKEN/i`) and every `DSH_*` name from the ambient parent
environment before spawning a child (`scrubbedParentEnv()`). This is real and was
exercised: a `CANARY_FAKE_API_KEY` is scrubbed, a `CANARY_HARMLESS_MARKER`
survives, and `DSH_*` names are scrubbed.

It is important not to mistake this for E01. It is:

- a NAME heuristic, in trusted code, not a kernel boundary;
- in the SUBPROCESS seam, not the sandbox — the sandbox has no part in it;
- defeated by any credential stored in a FILE, which the read finding above
  shows is readable from a confined child;
- defeated deliberately by an explicit `env` entry, which merges after the scrub
  by design.

So the honest statement is: **DSH on Windows has a credential-name scrub for
spawned processes and no credential isolation boundary.**

### Consequence for the daily system

E01's oracle — "denied at a real OS/adapter boundary; not a prompt promise" —
is not met. The relevant facts for the daily deployment:

- a confined child can read `~/.dsh`, a model key file, another session's files,
  and any credential on disk;
- what it CANNOT do is modify them (`EPERM`), which is a durability property, not
  a confidentiality one;
- the read exposure is bounded by what the agent's own OS user can read, so the
  practical mitigation is user-level separation, not this sandbox.

This gate must stay NOT_RUN (not PASS) until either the platform gains a read
boundary or the deployment's threat model is restated to exclude reads.

---

## E03 — permission change with a live PTY: PASS

### What was done

The fence lives in `@deepseek-ai/dsh-terminal-bash`'s `ensureSandboxModeFence`
(`src/index.ts:37-62`), installed on the owner's context at first `spawn()`. It
listens on `internal/dispatch` for a `sandbox/mode` session event and throws when
the owner has PTY activity:

> `cannot change sandbox mode from "<current>" to "<new>" while persistent terminal sessions are open or being created; wait for creation to settle and close them first`

The test mounts the real terminal registry, the real `'shell'` backend, the real
sandbox provider and the real subprocess provider, and spawns a REAL pwsh PTY
under `workspace-write` (pwsh, not bash: `/bin/bash` from Git Bash is not a
Windows executable path the PTY allocator can start).

### What was observed

- `ctx.terminals.hasOwnerActivity(owner)` is `true` while the PTY is live — the
  predicate the fence is built from.
- `setSandboxMode(session, 'read-only')` throws, and the message names both the
  old and the new mode.
- **The refusal is TOTAL.** The session log still holds ZERO `sandbox/mode`
  events and `ctx.sandboxPolicy.resolve({ session }).mode` still reports
  `workspace-write`. This matters: the event IS the store (`session-mode.ts`:
  "the switch IS its event"), so a fence that threw AFTER appending would still
  be a hole — a logged change is an applied change on replay. Asserting only
  "it throws" would have missed that.
- The fence is owner-scoped: an unrelated session changes mode freely, and the
  fenced session is unaffected by its neighbour's change.
- After `kill()`, `hasOwnerActivity` is `false` and the change succeeds — the
  sanctioned close-then-change path works, so the fence is a sequencing
  requirement, not a lock on the mode.
- The other half of the oracle — "the old PTY does not retain capability beyond
  the new authorization" — is closed by construction: because the change is
  forbidden WHILE a PTY is live, the state "live PTY minted under
  workspace-write, session now read-only" is unreachable. The test proves the
  reachable sequence: after close-then-downgrade, a fresh confined execution
  resolved through `ctx.sandboxPolicy` is denied (`EPERM`) and the file does not
  exist.

### The reach limit, stated plainly

Under `read-only`, **no PTY can reach readiness**. `terminals.spawn()` rejects
with the backend's own `PTY shell did not reach readiness before startup timeout`
after the full startup budget (probed at 5s, 8s, 12s and 30s — all time out; the
timeout is the bound, not a flake). So E03's refusal is only reachable in a mode
where a PTY can start.

This is a real limit on this gate's evidence, and it is also a user-visible
capability fact worth recording: **the strictest sandbox mode has no persistent
terminal on this platform.** The test asserts the failure and asserts the
rollback (`hasOwnerActivity` is `false` afterwards — no session was published for
the failed spawn).

This partially corrects an earlier record. `M6.1-terminal-qualification`
reported that `terminals.spawn()` "NEVER RESOLVES" under confinement. On this
host, under `workspace-write`, it resolves in ~0.8-1.2s. The M6.1 observation is
accurate for `read-only` (and M6.1's probe used `read-only`); it does not
generalize to `workspace-write`. The two records are consistent once the mode is
named, and the mode should be named.

---

## E06 — network egress: FAIL, no control exists

### What was done

The test starts a real HTTP server on `127.0.0.1` in the test process, confines a
child under each mode, and lets the child request it. The child is spawned
asynchronously — `spawnSync` would block the event loop that has to answer the
request, and that would look exactly like a denial. The test also attempts a raw
TCP connect to a public address (`1.1.1.1:443`) to show the loopback result is
not an artefact of the local server.

### What was observed

- Under BOTH `read-only` and `workspace-write`, the confined child completed the
  HTTP request and received the body: `HTTP_OK:CANARY-LOOPBACK-ANSWER`, exit 0.
- A confined child connected to a public address (`PUBLIC_CONNECT_OK`), with no
  denial signature and no runner failure.
- The sandbox wrap carries no network fact at all: `confine()` returns only
  `argv`/`enforcement`/`denialSignatures`/`runnerFailureRules`, and the runner's
  argv carries only file-effect arguments (`--workspace`, `--temp`, `--mode`).

The seam's own README is explicit: **"File effects are the whole policy
vocabulary — the seam expresses no network, process, syscall, device, or
credential restrictions."** That is now an executable fact, not a quotation.

### The only egress-adjacent control that exists

`@deepseek-ai/dsh-web-fetch-http`'s `src/network.ts` contains a genuine SSRF
guard, and it was exercised for real:

- `isPublicIpAddress` refuses `127.0.0.1`, `::1`, `169.254.169.254` (cloud
  metadata), `10.0.0.1`, and permits public unicast (`93.184.216.34`);
- `resolvePublicAddresses` rejects the whole answer set if any resolved address
  is non-public, with a structured `WEB_BLOCKED_URL` code — `127.0.0.1` and
  `localhost` both refused;
- the transport then PINS the connection to the validated addresses
  (`createPinnedLookup`), so the hostname cannot re-resolve to a private address
  between validation and connect.

This is a real control. It is also **not an egress boundary**:

- it constrains the URL the MODEL hands the `web_fetch` tool — it is a
  destination filter on one tool, not a block on outbound traffic;
- it has no relationship to `ctx.sandbox`, which cannot express a network policy;
- it is trivially bypassed by any confined shell command (proven above), so it
  offers no protection against a script the model chose to run.

### Why this is recorded as FAIL

The gate's oracle is "an external boundary intercepts; the tool filter must not
masquerade as network isolation". No external boundary intercepts. Recording this
as NOT_RUN would understate what is now known: the absence of egress control is
demonstrated, not assumed. FAIL is the accurate status — the gate's requirement
is unmet, and the evidence is a reproduced round trip.

---

## Safety and scope

- **Only fabricated canary values.** `CANARY-FAKE-SECRET-7f3a91c4-...` and
  `CANARY-HARMLESS-MARKER-INSIDE-WORKSPACE` exist only in the fixture. No real
  credential, no `~/.dsh`, and no user data was read at any point.
- **`ctx.terminalController` is never touched.** It is the human Web terminal and
  runs with system-user privilege; reaching it from a model-facing path would be
  escalation. The test composition mounts no such service, and one test ASSERTS
  that (`ctx.get('terminalController')` is `undefined`), so the constraint is
  enforced rather than merely stated in a comment.
- **The fixture is copied, never used in place.** The Windows ACL rung
  materializes a STANDING, inheritable ACE on the workspace root it is given and
  never revokes it (that ACE is the cross-session reuse cache, by design).
  Handing it the checked-in fixture path would leave standing ACEs on this
  repository. `stageCanary()` copies to a temp directory, and a test asserts the
  staged paths are outside `qualification/` and that `outside/` is a sibling of
  `workspace/`.
- **No assertion was weakened.** Where the platform does not deny, the test
  asserts the observed non-denial and this file records the gate as unmet.

## Reproducing

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
npx vitest run src/security-denial.test.ts
```

16 tests, all passing. `tsc.txt` records both the package-wide typecheck and an
explicit typecheck of the test file — the package `tsconfig.json` excludes
`src/**/*.test.ts`, so the test file is NOT covered by the package-wide run, and
the evidence states that rather than implying coverage.

`DSH_SRC_ROOT` may be set to relocate the pinned checkout; the default is the
path `compatibility.lock.json` records. `web-fetch-http` is not junctioned into
this package's `node_modules` (this project links only the packages it consumes),
so `network.ts` is imported by absolute path.
