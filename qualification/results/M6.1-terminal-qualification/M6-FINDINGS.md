=== M6: native terminal qualification ===

QUESTION: can one tool call leave state in a PTY that a LATER tool call reads?

ANSWER: YES, unconfined. And that qualifier is the important part.

--- PROVEN (9 tests, all passing) ---
T01  registry + 'shell' backend really mounted (listBackends contains 'shell')
T02  spawn takes type/name/cwd; the identity field is 'sessionId', not 'id'
T03  A VALUE SET IN ONE SEND IS READABLE IN A LATER SEND on the same PTY.
     This is the core qualification: cross-call persistent computation works,
     so IPython inside that PTY would keep state too.
T03  owner isolation: owner B sees 0 terminals, and reading A's id as B THROWS.
T04  a send result carries a WAIT REASON, and has no exitCode/succeeded field.
     startSend resolving is not a completion signal.
T04  a quiet command settles as inferred_idle, a heuristic.
T07  read() is a bounded view: count=5 returned <=5 lines and reports
     totalLines + truncated rather than pretending to be a complete log.
T09  kill returns true and removes the session.
T09  killing releases the session; list() is empty afterwards.

--- THE FINDING THAT MATTERS MOST, and it is a limitation ---

ctx.terminals.spawn() DOES NOT RESOLVE under a confined sandbox mode.
The chain was probed layer by layer:

  terminal registry mounts, lists 'shell' backend              OK
  a REAL Agent is created and accepted as PTY owner            OK
  sandboxPolicy.resolve() -> read-only + workspaceRoot         OK
  sandbox.confine() -> real argv wrapping sandbox-windows-acl  OK
      enforcement reported as 'partial'
  subprocess.spawnTerminal(raw argv)        -> resolves ~30ms   OK
  subprocess.spawnTerminal(CONFINED argv)   -> resolves ~29ms   OK
  terminals.spawn() under read-only         -> NEVER RESOLVES  HANG
  terminals.spawn() under workspace-write   -> resolves ~0.8-1.2s OK   [RE-MEASURED]
  terminals.spawn() under danger-full-access -> resolves ~740ms OK

CORRECTION (added after re-measurement, see G-FIX-07):
  The original probe tested ONLY read-only and the consequence below was
  written as though the hang covered confinement generally. It does not.
  Under workspace-write, spawn resolves in ~0.8-1.2 s. The hang is REAL but
  MODE-SPECIFIC to read-only, where it times out at every budget tried
  (5/8/12/30 s). The records reconcile once the mode is named.

So the boundary is precise: under read-only the Windows ACL runner wraps the
shell as
  node runner.js --workspace ... --mode read-only -- powershell.exe -NoLogo -NoProfile
and the terminal backend's prompt/idle handshake does not complete through that
wrapper. Every layer beneath was proven independently, so this is an upstream
platform interaction, not a test artefact and not a defect in this project.

CONSEQUENCE, stated without softening:
  Cross-call persistent computation on the native terminal is QUALIFIED under
  workspace-write and danger-full-access on this machine. It is NOT_RUN under
  read-only, where spawn does not complete at all. The capability works when
  writes are permitted and fails when they are forbidden, which is a real
  constraint on how tightly a daily driver can be locked down.

WHY THIS DOES NOT LEAD TO 'WRITE AN ADAPTER':
  The plan requires any thin adapter to reuse the DSH terminal's physical
  lifecycle. If spawn does not complete under confinement, an adapter over it
  cannot either. The honest next moves are (a) reproduce this upstream with a
  minimal fixture and report it, then (b) reconsider the provider question.

--- ALSO FOUND: the terminal service rejects a forged owner ---
  TerminalSessionService.ensureOwnerCleanup checks
  ctx.get('agents')?.get(owner.id) === owner
  (packages/terminal/terminal/src/index.ts:318-324). A hand-made owner object is
  rejected with OWNER_NOT_LIVE. The first version of this test file used stubs
  and every case failed with that message. This is a real safety property: a
  stale or forged reference cannot reach someone else's PTY.

--- M6 DECISION ---
  Native terminal is sufficient for cross-call persistence under
  workspace-write and danger-full-access.
  No thin adapter is justified by this evidence, because the gap is not
  framing or I/O shape - it is that spawn does not complete under read-only.
  A dedicated Jupyter provider is NOT justified either and is NOT implemented.
  The read-only interaction is recorded as an open gap, not worked around.
