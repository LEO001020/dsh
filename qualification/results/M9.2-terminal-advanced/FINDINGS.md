# M9.2 — terminal gates T05, T06, T08

Runner: `packages/dsh-daily-work/src/terminal-advanced.test.ts`
sha256: `b202350f3e09e6cfb292a92fb8febd3376df6b04a419aa627f055b336fa5888e`
Result: **10 passed / 10**, `vitest run` exit 0. `tsc -p tsconfig.json --noEmit` exit 0.
All three gates closed on this machine.

Rig: the one `terminal.test.ts` established — real Agents (the service rejects a
forged owner), real `ctx.terminals`, real ConPTY, mount order as M6 documented.

---

## THE LIMIT THAT APPLIES TO EVERYTHING BELOW

Every measurement here was taken with `sandboxPolicy.mode: 'danger-full-access'`.
That is not a preference. M6 established that `ctx.terminals.spawn()` never
resolves under a confined mode on this Windows machine, so no gate in this file
could be exercised confined at all.

So the honest scope is: **T05, T06 and T08 are closed for the terminal lifecycle
in UNCONFINED mode.** Their behaviour under `read-only` / `workspace-write` is
NOT_RUN, for the same upstream reason M6 recorded. A gate closed with the sandbox
off is weaker than one closed with it on, and this file does not blur that.

`ctx.terminalController` is not touched anywhere: it is the human Web terminal
running with system-user privilege, and wrapping it would be privilege escalation.

---

## T05 — INTERRUPT: CLOSED

Stimulus: SIGINT while a long cell holds the execution path.
Oracle: the control request is not blocked by the execution lock, and the state
reported afterwards is honest.

**1. The control path is genuinely separate, and that is proven by contrast.**

`startSend` is serialized: while a cell is in flight, a second `startSend` on the
same session is refused with `SEND_ACTIVE`. In the same instant, on the same
session, `ctx.terminals.signal(owner, id, 'SIGINT')` resolves. The two calls are
made back to back inside the test, so the refusal and the delivery are the same
moment in the same session:

    second startSend during the cell  ->  throws, code SEND_ACTIVE
    signal() during the cell          ->  resolves

Measured: the cell had ~9.5 s of its 12 s sleep left when the signal was sent.
The signal resolved in **8–9 ms**. A control path that waited on the execution
path would have taken seconds. That is the separation, measured rather than
asserted.

**2. The signal really stops the command, not merely the wait.**

`delivered: true` is the backend saying it wrote the byte; it is not proof the
command stopped. The proof is the command's own trailing output: a 12-second
sleep interrupted at 2.5 s never prints its token, **even after the full 12
seconds have elapsed**. The token is assembled inside the shell at runtime
(`('LATE'+'-TOKEN')`) so the PTY's echo of the command line cannot contain it —
without that, the assertion would pass on the echo alone and mean nothing.

**3. The reported state is honest.**

    waitReason      stdin_read
    sessionStatus   { kind: 'running' }
    fields present  viewport, waitReason, sessionStatus, truncated

The interrupt ends the WAIT. The shell is still alive and accepts the next cell,
which the test confirms by sending one afterwards. Nothing in the result claims
the cell succeeded; there is no field that could.

**4. The signal is authorized, not open.**

`signal` on another owner's session is refused (`FOREIGN_SESSION`), and on a
killed session it is refused (`NO_SESSION`). An unauthenticated interrupt would
be a route into another owner's PTY.

### The real `TerminalSignalResult`, reported as observed

    { delivered: true, targetPgid: 0 }

`targetPgid: 0` is worth stating plainly rather than passing over. On Windows
`WindowsProcessInspector.foregroundPgid` returns the shell pid as a stand-in
group, and node-pty reports `pid: 0` for this ConPTY session, so the number
carries no POSIX process-group identity here. What is actually delivered is a
`\x03` input write that conhost turns into a console-wide Ctrl-C
(`subprocess-local/src/terminal.ts:205-213`). So on this platform `delivered` is
the backend's claim that it wrote the interrupt byte, and `targetPgid` should not
be read as a group id. **The behavioural proof in (2) is what carries this gate,
not the result struct.**

---

## T06 — HOST LOSS AND ID REUSE: CLOSED

Stimulus: kill the host mid-execution, restart, and the same terminal id appears.
Oracle: the new epoch does not impersonate the old kernel, and no unknown cell is
auto-replayed.

**1. A fresh context starts empty and refuses a historical id.**

Terminal ids are minted `pty-N` from a counter starting at 0 in every process, so
reuse is guaranteed, not hypothetical. Proven end to end: generation 1 spawns
`pty-1`, writes a marker into its scrollback (asserted present, so the later
absence check is not vacuous), and is disposed. Generation 2, same owner id:

    list(owner) at start              ->  []           (no terminals)
    read(owner, 'pty-1')              ->  throws, code NO_SESSION
    spawn(owner)                      ->  'pty-1'       (the id IS reused)
    scrollback of the new 'pty-1'     ->  does not contain the generation-1 marker

The id is reused and the state is NOT. A new host mints the same name for a new
process, and the registry refuses the old name rather than resolving it. That is
the property the gate asks for: the name is not an identity.

**2. A running cell does not survive its host.**

The in-process check cannot show this, so a real second Node process boots the
same rig, writes a **control file** (proving that shell can write files at all),
then starts a cell that writes a marker file after 6 seconds. The host is
SIGKILLed while that cell is mid-sleep.

    control file after READY      present     (the write path works)
    marker file, immediately      absent
    marker file, after 9 s        ABSENT

Without the control file this test would pass for the wrong reason if the write
path were simply broken. With it, the absence means the cell was killed with its
host.

**3. The absence of a replay path is asserted as an absence.**

There is no code path in this project that could auto-replay a historical cell.
Asserted three ways against the package's own sources:

- No non-test file in `src/` contains `ctx.terminals`, `ctx.terminalController`,
  `startSend`, or `terminalController`. The list is asserted `toEqual([])`, so
  adding a terminal call to production code fails this test and forces a human
  decision. (The `work` tool and the host service reach no terminal.)
- The durable record is the only thing that crosses a restart, so it is the only
  place a replayable identity could be stored. `runRecordSchema` has no key
  matching `/pty|kernel|cell/i`; its only `terminal`-matching key is
  `terminalTombstones`, which holds closed **task** ids (`host.ts` compares them
  against `input.taskId`), not PTY sessions.
- `reconcile.ts` states the governing rule verbatim: `NEVER auto-replay`.

This is a source-level check and it is honest about being one: it proves no such
call exists **today**, in this package. It is not a runtime proof, and it would
not catch a replay path added in a different package.

---

## T08 — ERROR AND FRAMING: CLOSED

Stimulus: an exception, a user-printed fake completion marker, a blocking read.
Oracle: error/unknown is never mistaken for success; framing is not
verification.

**1. A failed command cannot be reported as success — structurally.**

The strongest form of this is not that the code reports failures correctly, but
that there is no field in which a verdict could be wrong. Measured on both a
successful and a failing command:

    fields        viewport | waitReason | sessionStatus | truncated  (identical)
    verdict-ish fields (matching /exit|success|ok|fail|error/i)      NONE

A failing command settles with `waitReason: stdin_read` and
`sessionStatus: { kind: 'running' }` — indistinguishable from success at this
layer. The failure is visible only as text (`Exception: BOOM-TOKEN`) that a
caller must interpret. There is no exit code to read, and that is the finding.

**2. A forged completion marker is accepted as readiness, so framing is not
verification.**

The backend treats the shell's own OSC `133;D;` marker plus the printable prompt
as readiness evidence. A program can print that sequence itself. Measured A/B in
one session:

    baseline  `Start-Sleep 12; Write-Output <token>`                  3031 ms  inferred_idle
    forged    `<print OSC 133;D;0 + 'dsh> '>; Start-Sleep 12; ...`     129 ms  stdin_read

The forged command settles **129 ms** after it starts, reporting `stdin_read`,
while the command is still sleeping and has produced nothing. The token appears
only once the real 12 seconds elapse. The baseline control rules out the trivial
explanation that the poller simply never waits.

So: framing is a **readiness** signal, and readiness is not completion. A
verification that trusted this framing could be defeated by any program that
printed six bytes. `INV-T5` holds, and it holds for a reason worth recording:
the marker is not tamper-proof, and no downstream check may treat it as such.

**3. A blocking read settles as a wait, never as completion.**

`python -c "... input() ..."` with a real Python 3.14.3 on PATH:

    waitReason      inferred_idle      (the REAL value on this platform)
    sessionStatus   { kind: 'running' }
    viewport        contains 'WAIT> '  (the prompt the program printed)

`inferred_idle` — not `stdin_read` — is what this platform actually reports, and
the difference is recorded rather than papered over: the exact stdin-wait probe
is unavailable on Windows (`windows-inspector.ts:101` returns `false`
unconditionally), so the settle comes from the idle-silence heuristic. Both are
non-success reasons and the assertion accepts exactly those two.

The proof that the cell had **not** completed is behavioural: the next cell's
text is consumed by the still-blocked read as its input and echoed back as
`REPLY-NEXT-CELL-TEXT`. A caller that treated the settle as completion would have
lost that next cell silently. (A pwsh `Read-Host` behaves the same way.)

**4. The only exit code that appears describes the shell, not the work.**

`exit 3` yields `waitReason: session_exit` with
`sessionStatus: { kind: 'exited', exitCode: 3, signal: null }`. That code belongs
to the top-level process, not to whatever command happened to be running, so
attributing it to a cell would be a category error. The dead session stays listed
and honestly reports itself exited, and a further send is refused
(`PTY session has exited`) rather than written into a process that is gone.

---

## TWO REAL DEFECTS FOUND WHILE BUILDING THIS (both in the test, both fixed)

Recorded because they are traps the next person will meet, and because a green
run that hid them would be worth less than this paragraph.

1. **`terminals.signal` throws SYNCHRONOUSLY on refusal.** It is not `async`: it
   returns `this.expectOwned(...).session.signal(...)` directly
   (`terminal/src/index.ts:274-276`), so the authorization check runs before any
   promise exists. `await expect(...).rejects.toThrow()` fails on it — the throw
   escapes before `expect` is reached. The test now catches both shapes.

2. **Nested escaping in a generated child source fails invisibly.** An earlier
   version of the T06 process-boundary test assembled the shell command inside the
   template literal; `\\` collapsed to `\`, the child's own string literal read it
   as an escape, and the child died in 292 ms with a `SyntaxError` in source the
   test never printed. The command is now built in the test process and
   interpolated as one `JSON.stringify`, and the child's boot is an assertion
   (`READY`, no `SyntaxError`) rather than a precondition to hope for.

---

## WHAT IS PROVEN, AND WHAT IS NOT

**Proven on this machine, unconfined, with the runner above:**
T05 (independent control path, 8–9 ms against a running cell; the command really
stops; honest post-state; authorized signalling). T06 (fresh context empty;
historical id refused while the id is genuinely reused; a running cell dies with
its host, with a positive control; no replay call site in this package). T08 (no
verdict field on a send result; a forged marker settles in 129 ms, so framing is
not verification; a blocking read settles as a non-success reason and consumes
the next cell; the only exit code is the shell's).

**Not proven, and not claimed:**
- Any of this under a **confined** sandbox mode. `spawn` does not complete there
  on this machine, so all three gates are UNCONFINED-only.
- That a host killed mid-cell leaves **no orphaned OS process**. The cell's
  output provably stops; the process table was not audited afterwards. M6's
  owner-disposal cleanup is the relevant mechanism and it was not exercised here.
- That the absence of a replay path holds **outside this package**. The check is
  a source scan of `src/*.ts` in `dsh-daily-work` only.
- Anything about a **real IPython kernel**. These are shell-level cells; a
  dedicated kernel remains unjustified and unimplemented, as M6 concluded.
- `delivered: true` as an independent fact. On Windows it is the backend's claim
  that the interrupt byte was written; the behavioural evidence in T05(2) is what
  carries the gate.

## DECISION

T05, T06 and T08 move from NOT_RUN to **PASS (unconfined)**, and the qualifier is
part of the result, not a footnote. `daily_ready` should not be read as satisfied
by these three alone: the confinement limitation M6 recorded still applies to all
of them, and it is the same upstream gap.
