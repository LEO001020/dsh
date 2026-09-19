# M9.5: external-effect discipline (E07, E08, E09, E10, E11)

METHOD: a per-operation effect ledger over the REAL storage domain (the same
`dsh-storage-json` backend and `dsh-storage-domain` facility the production
host mounts), plus a counting in-process fake as the remote. No socket is
opened; nothing here touches the network.

Files: `packages/dsh-daily-work/src/effects.ts`, `src/effects.test.ts`.

## What the design actually guarantees

The claim is deliberately narrow. It is NOT exactly-once, and it is not a
universal effect WAL. There is no global log, no two-phase commit and no
cross-service coordination. `EFFECT_LIMITS` in the source states the same
limits in the code, and they are repeated here because a green suite invites
the wrong reading:

1. **One transport invocation per operationId per recorded state, inside one
   process.** Two processes over the same medium are outside the guarantee,
   exactly as they are for the run record.
2. **Unknown instead of a second send.** When the outcome cannot be
   established, the answer is `unknown` and nothing is resent.
3. **A refused change instead of a silent second action.** A payload change
   under a recorded operationId is a conflict, not a new operation.
4. **A cancellation is never reported as an undo.**

The mechanism is write ordering, and it is three writes per effect:
`intent_recorded` -> `sent` -> the outcome. The `sent` marker is written
BEFORE the transport call, which is what makes "no marker" a proof that the
call was never made rather than an absence of evidence.

## Gate results

All five gates **PASS**. Evidence: `tests.txt` (48 tests, exit 0),
`tsc.txt` (exit 0), `source-digests.txt`.

### E07 operation idempotency — PASS

The oracle is "same logical operationId reconciles, no repeated effect", and
the stimulus is a lost reply retried under a CHANGED tool callId. Both halves
are asserted against a counting fake:

- the operationId digests `(kind, logicalKey)` only, so a retry carrying a new
  callId lands on the SAME record — asserted directly, and separately for a
  parameter key order that was rebuilt differently;
- a first call confirms, the retry with a different callId reports
  `performed: false` and the counter still reads **1**;
- the restart shape: a fresh ledger over the same medium reconciles instead of
  resending, counter still 1;
- a lost reply records `unknown`, and the retry resolves it by QUERY
  (`queried: true`, counter still 1);
- with no query support the outcome stays `unknown` across three retries and
  the counter is still 1 — this is the SECURITY.md case where "the honest
  answer is unknown", and the value under test is that it is not converted
  into a resend;
- `reconcile()` reached the transport zero times across five operations in
  every recorded state, which is what makes "reconcile, never replay" a
  property of the module rather than a convention.

A `sendDecision` table is asserted over the WHOLE status space: only `absent`
and `intent_recorded` license a send, and both are proofs about our own write
ordering. `not_started` is refused too — a resend is a new authorization, not
a reconciliation step.

### E08 operation parameter conflict — PASS

- A changed payload under a recorded operationId returns `conflict` with
  `performed: false`, `queried: false`, and the counter unchanged.
- The original ack does NOT authorize the new action: `reconcile` of the
  changed parameters returns `conflict` with `resultRef: undefined`, rather
  than handing back the stale confirmation.
- The recorded authorization fields (`status`, `parameterDigest`, `resultRef`,
  `parameters`) are byte-identical after the refusal; the refused digest is
  appended to an audit list. `conflict` is deliberately NOT a stored status —
  a refused attempt must not overwrite the ack it was refused against.
- The ORIGINAL parameters still reconcile correctly after a conflict.

### E09 opaque shell — PASS, and the demonstration is adversarial

The classifier defaults to `unknown`; only a closed, hand-audited allowlist of
plain, unqualified, metacharacter-free invocations can produce `read_only`.
Any metacharacter (`> < | & ; $ \` ( ) { } [ ] * ? ~ ! \ " '` newline, tab,
`#`, `%`, `^`) makes the text a PROGRAM, not a command, and returns `unknown`
before any other rule runs.

The gate is closed by DEFEATING the classifier with a real shell, not by
listing regexes that fail. Four defeats, each verified independently outside
the test suite as well, with an observed write to disk as the evidence:

| text the classifier calls `read_only` | how it was defeated | observed |
|---|---|---|
| `ls -la` | shell function bound to a read-only name | wrote `fn_marker` |
| `ls -la` | PATH-shadowed `ls` earlier on PATH | wrote `path_marker` |
| `cat notes.txt` | redirect hidden in a variable, re-parsed by `eval` | wrote `redirect_marker` |
| `ls -la` | function exported into a child `bash -c` | wrote `exported_marker` |

`CLASSIFIER_LIMITS` is part of the module's exported interface, so a reader
about to treat `read_only` as an authorization must read what the verdict does
not cover first. `mayRunAutomatically` is the only sanctioned reading, and it
returns false for `unknown` and `mutating` alike.

Two findings from building the allowlist, both holes a regex would have
shipped: `sort` had to be REMOVED from the read-only list because
`sort in out` writes with no flag at all; and `tar` writes with mode letters
and no dash anywhere in the text (`tar xf archive.tgz`), which needed a
separate bundled-flag table.

**The enforcement boundary is NOT this function.** Its verdict may not be used
as an authorization to run anything unattended. Enforcement for shell is the
sandbox and the process identity. The classifier exists to refuse, and to make
its own blindness visible.

### E10 PTC partial commit — PASS

A three-step program where step 2's post-effect work throws:

- `replayedWholeProgram: false` (a literal in the type, not a runtime flag);
- the counter proves two effects were sent, not three and not zero;
- step 2's committed effect is reconciled INDIVIDUALLY after the throw, and
  its report says so;
- step 3, never entered, is `unknown` with `not_reached` — deliberately NOT
  `not_started`. The runner knows which steps IT entered, but the program body
  between steps is code it does not control, so a control-flow fact is not
  evidence about the remote;
- `resumeEffectProgram` reconciles each step individually with the counter
  unchanged, and re-reports the un-entered step as `unknown`;
- a lost reply inside the program stays `unknown` and is confirmed only by a
  later query, with no re-run.

### E11 cancellation does not roll back — PASS

`CancellationReport.reverted` is a **literal `false` in the type**. There is no
code path that can produce `true`, which is the difference between a policy
note and a property.

- Sent-and-unconfirmable: reports `mayHaveHappened: true`, `reverted: false`,
  `queried: true`, and the transport counter is unchanged.
- A committed effect queried after the user cancels reports `confirmed` — the
  committed outcome, not the cancellation the user asked for.
- `intent_recorded` reports `not_started` and says explicitly that this is a
  proof about our own write ordering, not an undo.
- An operation this ledger never recorded reports `unknown`, and says it does
  not claim the operation is impossible elsewhere. Cancellation does not
  become a claim about the world.
- A cancellation naming different parameters is a `conflict`, not a cancel.
- Across all five branches, no reason string matches
  `/rolled back|undone|reverted|reversed/`, and every recorded intent is still
  present afterwards.

## What is left open, stated plainly

- **Not exactly-once.** No amount of ledger writing makes a remote commit and
  a local write atomic. The guarantee is "one transport invocation per
  operationId per recorded state, and unknown rather than a second send".
- **The remote is trusted to answer truthfully.** A remote that reports
  `not_started` for an operation it actually committed defeats this design.
  A query is evidence, not proof.
- **Single-writer.** The per-operation serialization chain closes the
  check-then-write window inside ONE process. Two processes over one medium are
  outside it; the storage domain gives atomicity per record, not
  compare-and-set across processes.
- **No adapter for a real remote exists yet.** Every adapter exercised here is
  a local fake. A real adapter is task-specific and must be written against a
  remote that genuinely offers an idempotency key or a query endpoint. Until
  such an adapter exists for a given operation family, that family must not
  run automatically — which is the SECURITY.md rule, enforced by the
  `idempotencyKey || queryable` refusal, not merely documented.
- **The E09 classifier is not a control.** It is a refusal device. Gates E06
  (network egress) and E12 (verification-code isolation) remain NOT_RUN and are
  unaffected by this work.

## Not run

Nothing in this gate was skipped. The E09 adversarial tests assert the
presence of a real shell as a FAILURE rather than skipping, precisely so the
gate cannot go green for the wrong reason; bash was present and all four
defeats produced an observed write.
