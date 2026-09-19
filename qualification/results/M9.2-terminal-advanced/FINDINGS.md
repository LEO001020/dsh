# M9.2 — terminal gates T05, T06, T08

Runner: `packages/dsh-daily-work/src/terminal-advanced.test.ts`
sha256: `c55c961b78b59326ca8f8ea219f69001940526e89ef52382c60d8c7234716b74`
Result: **15 passed / 15**, `vitest run` exit 0.
Typecheck: `tsc -p tsconfig.check.json` — `terminal-advanced.test.ts` contributes
**0 errors** (see the note on the config below; the remaining errors in that
output are other slices' files, not this gate's).

Every number quoted below is emitted by the run as a `[measured]` line in
`tests.txt`, so it can be traced to a run rather than to a recollection of one.
The assertions are bounds; the `[measured]` lines are the actual values. Values
vary a little between runs (signal round trip 7–23 ms; forged-marker settle
138–185 ms), so the bounds are what the test enforces and the measured lines are
what the finding reports.

Rig: the one `terminal.test.ts` established — real Agents (the service rejects a
forged owner), real `ctx.terminals`, real ConPTY, mount order as M6 documented.

### Correction to an earlier version of this evidence: the typecheck was a FALSE PASS

An earlier `tsc.txt` recorded `tsc -p tsconfig.json --noEmit` exit 0. That config
EXCLUDES `src/**/*.test.ts` (correct for the build, so test code never emits into
`lib/`), which means it exits 0 **with or without** this gate's test file present.
It could not have failed, so it proved nothing about the file it was cited for.

The evidence now uses `tsc -p tsconfig.check.json`, which extends `tsconfig.json`,
keeps identical strict flags, and clears only the exclude. Under it this file
contributes 0 errors. The other file in that output (`tool-protocol.test.ts`) is
another slice's in-flight work and is not this gate's result. Recorded here
rather than quietly fixed, because "a green light appeared once" is exactly the
failure mode the qualification is supposed to catch.

**And the corrected config immediately earned its keep:** switching to it
surfaced 2 real type errors in this gate's own file — a `boolean` passed where
`measured()` requires `string | number`, in two calls. They are fixed. That is
precisely the class of error the old config was hiding, and it is a small,
concrete demonstration that the false pass was not hypothetical.

---

## THE LIMIT THAT APPLIED TO THE FIRST VERSION OF THIS FILE, AND WHAT REPLACED IT

The first version measured everything with `sandboxPolicy.mode:
'danger-full-access'`, because M6 recorded that `ctx.terminals.spawn()` never
resolves under a confined mode. That qualified the terminal only with the sandbox
OFF — the configuration a daily driver least wants.

That limitation is specific to **`read-only`**. `workspace-write` resolves
(~940 ms) and genuinely enforces. So the gates now run under BOTH modes: the
three main blocks unconfined, and a fourth block under a real ACL-wrapped
sandbox. `read-only` remains NOT_RUN and is not claimed.

The confinement arm is proven to be real rather than merely configured: a write
outside the workspace is DENIED and a write inside it is ALLOWED. Without that
check the "under confinement" results could be unconfined results wearing a
label.

`ctx.terminalController` is not touched anywhere: it is the human Web terminal
running with system-user privilege, and wrapping it would be privilege escalation.

---

## THE FINDING THAT MATTERS MOST: SIGINT DOES NOT STOP A CELL UNDER CONFINEMENT

**Under `workspace-write`, `terminals.signal(owner, id, 'SIGINT')` returns
`{delivered: true}` in ~17 ms and the command keeps running to completion.**

This is the opposite of the unconfined result, and it is the single most
important thing this slice found. Measured, repeated, with a token assembled
inside the shell so the echo cannot fake a match:

    confined   (workspace-write)  5/5 trials: command SURVIVED the interrupt
    unconfined (danger-full-access) 3/3 trials: command was STOPPED

    sampled, 20 s sleep, signal at 2.5 s, confined:
      4s:n 5s:n ... 19s:n 20s:Y 21s:Y ...      token first seen at 20141 ms
    sampled, same cell unconfined:
      4s:n ... 27s:n                            token NEVER seen

The token appearing at 20.1 s for a 20 s sleep is what distinguishes "ran to
completion" from "was killed late". It ran to completion.

**Mechanism.** Under confinement the backend spawns the shell through the
Windows ACL runner (measured argv):

    node runner.js --workspace <ws> --mode workspace-write -- <pwsh.exe -NoLogo -NoProfile>

On Windows the interrupt is delivered as a `\x03` input write, which conhost
turns into a console-wide CTRL_C (`subprocess-local/src/terminal.ts:205-213`).
That byte reaches the RUNNER's console, not powershell's foreground process, so
the running command is untouched. `delivered: true` is still reported, because
writing the byte succeeded.

**Why this is security-relevant, not a test detail.** A caller that treats
`delivered: true` as "the interrupt landed" will believe it has stopped a cell
that is still running and still able to write inside the workspace. Under the
one mode where confinement actually protects anything, the interrupt control
path silently does nothing while reporting success. This belongs alongside the
E01/E06 FAILs as a measured boundary of what can be trusted, and it is the
strongest argument yet for the rule that a signal result is never a completion
signal.

**SIGTERM is the same.** Confined `SIGTERM` also returned `delivered: true` and
the command survived. So the boundary is not "some signals work": it is
signal-based interruption as a whole.

**The mitigation, also measured.** `terminals.kill()` DOES stop the cell under
confinement (1/1, token never appears, session removed). It reaches the real
process tree through the registry's teardown path (taskkill on the verified root
identity) instead of through a console input byte. So a confined caller must
tear the session down rather than interrupt it — and the cost of that is losing
the session's state, which is precisely what the persistent PTY was for.

**Scope of the claim.** Measured on this machine, in `workspace-write`, with the
pwsh dialect. `read-only` is NOT_RUN (spawn hangs). No claim is made about other
platforms, other dialects, or other confinement modes.

---

## T05 — INTERRUPT: CLOSED (unconfined), and LIMITED (confined)

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
The signal resolved in **7–23 ms** across runs (the run captured in `tests.txt`:
7 ms). A control path that waited on the execution path would have taken
seconds. That is the separation, measured rather than asserted.

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
verification. This is a SECURITY-RELEVANT finding, not a test detail.**

The backend treats the shell's own OSC `133;D;` marker plus the printable prompt
as readiness evidence. A program can print that sequence itself. Measured A/B,
each in its own fresh session, in BOTH sandbox modes:

    baseline  `Start-Sleep 12; Write-Output <token>`                  3025-3191 ms  inferred_idle
    forged    `<print OSC 133;D;0 + 'dsh> '>; Start-Sleep 12; ...`    138-185 ms   stdin_read

The forged command settles in **~170 ms**, reporting `stdin_read`, while the
command is still sleeping and has produced nothing. The token appears only once
the real 12 seconds elapse. The baseline control rules out the trivial
explanation that the poller simply never waits. The same result reproduces under
`workspace-write` (168 ms), so confinement does not change it.

The bound is derived from the mechanism rather than fitted to the observation:
without the marker the only path to a settle is the idle-silence heuristic, which
needs `idleSilenceMs = 3000 ms` of quiet (`terminal-bash/src/config.ts:104`),
while the forged marker satisfies the prompt-readiness branch instead. The test
asserts `< 1500 ms`, which is reachable only by accepting the forged framing, so
a regression that stopped accepting it would settle at ~3000 ms and FAIL rather
than quietly pass. That bound has ~8x headroom over the observed value.

**WHY THIS IS A BOUNDARY OF WHAT CAN BE TRUSTED.** The prompt marker is the
terminal's only in-band completion evidence, and it is trivially forgeable: any
cell can print six bytes and claim it finished. So:

- A verification that treats the marker, the prompt, or the settle as proof that
  a cell did what it claimed can be defeated by the cell being verified. That is
  the same class of failure as E01/E06 (a self-reported success that no
  independent check confirms), and it is measured here rather than argued.
- The correct reading is the one `INV-T5` states: framing is a READINESS signal.
  It tells a caller that the terminal is ready for more input. It says nothing
  about whether the work succeeded, and it cannot, because the party it would be
  reporting on is the party that prints it.
- Anything that must be trusted about a cell's effect needs an independent
  artifact: a file with a known digest, an exit status from a process the cell
  did not control, or a separate check. This is why the `work` tool's `finish`
  action is a REQUEST that still runs acceptance, rather than a verdict.

This belongs alongside the E01/E06 FAILs in the ledger of measured trust
boundaries: it is not a defect in the terminal (the backend is doing exactly what
it documents, and the marker is only ever claimed as readiness evidence), but it
is a hard limit on what any layer above may infer from terminal output.

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

## SIX REAL DEFECTS FOUND WHILE BUILDING THIS (all in the test, all fixed)

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

3. **The settle viewport is not a reliable read of the current cell.** One
   version of T05(2) asserted the follow-up cell's output from
   `send().viewport` and failed intermittently, returning the PREVIOUS cell's
   text. That is T08's own finding appearing inside T05: a settle reports a wait
   ending, and the viewport at that moment can still be the leftovers of what ran
   before. The assertion now reads scrollback after the cell has had time to
   produce output. Recorded because it is a live trap for any consumer, not just
   for this test.

4. **Measuring two things in one session couples them.** The T08 A/B originally
   ran both the baseline and the forged command in one session with a SIGINT
   between them, and it flaked under load: the second measurement depended on how
   fast the shell recovered from the interrupt rather than on framing. Each
   measurement now gets its own fresh session. The flake was real, and it was
   hiding a dependency the test did not intend to assert.

5. **A typecheck config that excludes the file under test is a false pass.**
   `tsc -p tsconfig.json --noEmit` exits 0 whether or not this test file exists,
   because that config excludes `src/**/*.test.ts`. The evidence was corrected to
   `tsc -p tsconfig.check.json`. Worth recording as a general trap: a green
   typecheck means nothing unless the config actually includes what it claims to
   cover.

6. **A 4-character probe tag silently disables the anti-echo guard.** The token
   guard splits a marker in half so the PTY echo cannot contain it. With a
   4-character tag the second half is the EMPTY string, the assembled token
   degenerates to the bare marker, and the echo then matches it — so the probe
   reported "command survived the interrupt" in every mode, including the
   unconfined control where the command was in fact killed. This bug appeared in
   the ad-hoc probe used to characterize the confinement finding, and it produced
   a wrong answer before it was caught. The test file's `TOKEN` helper splits at
   index 4, which is safe only because every marker it is given is longer than 4
   characters; the probe now asserts its tag length. This is the single most
   dangerous defect in this list because it fails toward a plausible-looking
   positive result.

---

## WHAT IS PROVEN, AND WHAT IS NOT

**Proven on this machine, with the runner above:**

*Unconfined (`danger-full-access`):* T05 (independent control path, 7–23 ms
against a running cell; the command really stops; honest post-state; authorized
signalling). T06 (fresh context empty; historical id refused while the id is
genuinely reused; a running cell dies with its host, with a positive control; no
replay call site in this package). T08 (no verdict field on a send result; a
forged marker settles in ~170 ms, so framing is not verification; a blocking read
settles as a non-success reason and consumes the next cell; the only exit code is
the shell's).

*Confined (`workspace-write`, ACL runner in the spawn path, enforcement proven by
a denied out-of-workspace write):* the same T06 result (state does not cross a
context boundary; `pty-1` reused without adoption). The same T08 result (forged
marker settles in 168 ms; a failing command still has no verdict field). And the
new T05 result: **SIGINT reports `delivered: true` and does NOT stop the cell;
`kill()` does.** 5/5 confined trials survived SIGINT; 3/3 unconfined controls
were stopped.

**Not proven, and not claimed:**
- Anything about **`read-only`** mode. `spawn` does not complete there on this
  machine, so it remains NOT_RUN. The confinement claim covers `workspace-write`
  only, and no other mode is implied.
- That a host killed mid-cell leaves **no orphaned OS process**. The cell's
  output provably stops; the process table was not audited afterwards. M6's
  owner-disposal cleanup is the relevant mechanism and it was not exercised here.
- That the absence of a replay path holds **outside this package**. The check is
  a source scan of `src/*.ts` in `dsh-daily-work` only.
- Anything about a **real IPython kernel**. These are shell-level cells; a
  dedicated kernel remains unjustified and unimplemented, as M6 concluded.
- `delivered: true` as an independent fact, in EITHER direction. Unconfined it
  coincides with a stopped command; confined it coincides with a command that
  runs to completion. The behavioural evidence is what carries both results, and
  this is now the strongest available demonstration that a signal result must
  never be read as a completion signal.
- That the confined SIGINT failure is **upstream's bug rather than this project's
  configuration**. It follows from delivering Ctrl-C as a console input byte to a
  wrapped process, but whether the wrapper could forward it is not something this
  slice investigated. Recorded as a boundary, not as a diagnosis.

## DECISION

T05, T06 and T08 move from NOT_RUN to **PASS** — and T05's PASS is split, because
the two modes genuinely differ:

| gate | unconfined | workspace-write |
|---|---|---|
| T05 interrupt | PASS — control path independent, command stops | **PASS with a documented limitation** — control path independent, but SIGINT/SIGTERM do not stop the cell; `kill()` is required |
| T06 host loss / id reuse | PASS | PASS |
| T08 error and framing | PASS | PASS |

The T05 confinement result is not a failure of the gate's oracle (the control
request genuinely is not blocked, and the reported state is honest about what it
is). It is a **security-relevant limitation** that any caller must know: under
confinement, interrupting a cell does not stop it, and tearing the session down
is the only control that works. `read-only` remains NOT_RUN.

`daily_ready` should not be read as satisfied by these three alone.
