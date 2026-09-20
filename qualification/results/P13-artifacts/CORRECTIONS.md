# P13 — corrections and caveats on this evidence directory

Two things a reader of these artifacts must know before citing them.

## 1. `before-probe.json`'s `armC` measured NOTHING. Do not cite it.

The committed `before-probe.json` records:

```
"armC_argumentsOverFrameLimit": { "outcome": "ok", "stdout": ["C_RAISED:no"] }
```

That is a **false negative**, not a finding. The arm passed
`{'chars': 5242880}`, which serializes to about 25 bytes: the *number* was
large, the *frame* was not. `ARGUMENTS_TOO_LARGE` was therefore never reached,
and the arm reported no refusal for a reason that had nothing to do with the
frame limit.

This is the defect shape this project has recorded most often — a check that
never fires and a check that is absent produce identical evidence — and it was
caught by the coordinator asking why a documented check had not raised.

The corrected arm is in `after-probe.json` and builds the payload **inside the
cell**, printing the exact serialized byte count and the limit so the arm is
self-falsifying:

```
"C_ARGS_JSON_BYTES:5242892",
"C_FRAME_LIMIT:4194304",
"C_RAISED:yes",
"C_CODE:ARGUMENTS_TOO_LARGE",
"C_TYPE:BridgeError"
```

**The send-side frame check is real and does fire**, at the client, before the
socket write. Cite `after-probe.json` for this, never `before-probe.json`.

`armA`, `armB` and `armD` in `before-probe.json` were unaffected by this bug and
remain valid.

## 2. Commit `2040822`'s message is missing three inline code spans.

The message was written with backtick-quoted phrases, and the shell performed
command substitution on them before `git commit` saw the text. The three lost
spans, restored here:

| where the message has a gap | what it should read |
|---|---|
| "failed on `outcome` rather than on the property" | `outcome` |
| "the two-digest cross-check disabled (`if (false && ...)`)" | `if (false && ...)` |
| "On the unified plane `artifact.path` is undefined, so M3 writes `undefined`" | `artifact.path`, `undefined` |
| "throws `service \"ipython\" has been registered`" | `service "ipython" has been registered` |

Nothing else in that message is affected, and no code or evidence was touched by
the substitution — only the message text. The commit was **not** amended
(amend is prohibited on this branch), so this note is the correction of record.
