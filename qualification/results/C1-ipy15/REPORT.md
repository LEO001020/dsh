# C1 / IPY-15 clause 2 — the over-limit frame's loss, measured and wired

**Verdict: clause 2 now holds for the paths measured. It did NOT hold when this
writer started, and the reason was stronger than the filed FAIL said.**

The clause: *"An over-limit frame is reported as LOST with a count, never as
empty output."*

**Which reading I measured: (ii).** The loss was raised where the cell result
never carried it. It was not merely an unwired counter — the refusal reached the
caller as a bare error with no count on it, and a second loss path (the iopub
pump) swallowed the frame entirely and told the model nothing.

---

## 1. The measurement that decided (i) vs (ii)

Driver: `packages/dsh-ipython/src/c1-ipy15-output-loss-measure.ts`.
Seven arms, each against a REAL ipykernel through the REAL `broker.py`.
Raw output: `qualification/results/C1-ipy15/after/output-loss.json`.

| Arm | Stimulus | BEFORE (measured) |
|---|---|---|
| 1 | output over the CAP, under the frame bound | `truncated: true`, spill path named, `droppedFrames: 0` — the CONTROL arm; this loss-reporting path already worked |
| 2 | output over the FRAME bound (raised cap) | `KernelTransportError FRAME_TOO_LARGE`, `errorCarriesCellResult: false`, no count |
| 3 | one IOPub write over the bound | delivered WHOLE — libzmq refuses nothing here (see §5) |
| 4 | 200 × 64 KiB `display()` at the **DEFAULT 256 KiB cap** | 13,118,726-byte reply refused, no count |
| 5 | a 4,456,448-byte background write AFTER its cell settled | **the frame was refused INSIDE the iopub pump and only logged** — `droppedFrames: 0`, no refusal event, 4.4 MB gone |
| 6 | is the tally readable? | field present at runtime, **absent from every host type** |
| 7 | does display ever DROP an entry? | 2 over-limit entries, both KEPT and truncated — never dropped |

The decisive BEFORE facts (arm 2):

```
arm2_errorMessage: "FRAME_TOO_LARGE: frame of 4718913 bytes exceeds the limit"
arm2_errorCarriesCellResult: false
arm2_errorHasDroppedFramesField: false
```

That sentence states the bound and the size. It never says the bytes are GONE. A
reader could take it for a size complaint about a frame that was retried or
trimmed. It was neither — the frame was refused before a byte was written.

**Arm 4 matters because it makes the defect production-reachable.** Arms 2/3 need
a raised cap, which no session uses. Arm 4 uses the shipped 256 KiB cap and still
produces a 13 MB reply, because `_absorb_display` bounds each display entry at
64 KiB but nothing bounds the NUMBER of entries.

---

## 2. What I changed, and where

| File:line | Change |
|---|---|
| `broker.py:336-358` | `FrameLimitError` carries `refused_frames = 1` (a constant — a refusal IS one frame) and `cell_ran` (defaulted `False`: the conservative claim is "nothing ran") |
| `broker.py:361-387` | `refused_frame_loss_message(exc)` — ONE sentence builder, so the reply and the transport event cannot drift into two accounts of one refusal |
| `broker.py:390-411` | `frame_too_large_event` detail is now the loss sentence, plus `refusedFrames` as a **field** |
| `broker.py:1446-1451` | the REPLY path sets `cell_ran = True` and replies with the loss sentence instead of bare `str(exc)` |
| `protocol.ts:436-448` | `refusedFrames?: number` on the `transport_refused` event type |
| `protocol.ts:526-542` | the decoder VALIDATES it and drops a negative rather than passing through a value no arithmetic can use |
| `protocol.ts:296-315` | `transportDroppedFrames?: number` declared on `KernelStatus` (arm 6: it was a runtime extra no host type named) |
| `kernel.ts:420-430`, `kernel.ts:699-712` | the count is carried through into the host's recorded refusal, and typed there |
| `v3-spec-gates.test.ts:1249-1311`, `1400-1421` | the pins now assert the NEW truth, with two controls |

### BEFORE / AFTER, arm by arm

| Arm | BEFORE | AFTER |
|---|---|---|
| 2 (reply, raised cap) | `FRAME_TOO_LARGE: frame of 4718913 bytes exceeds the limit` | `FRAME_TOO_LARGE: 1 frame(s) LOST; frame of 4718913 bytes exceeds the limit; declared 4718913 bytes, limit 4194304 bytes; the cell ran and its result was not delivered` |
| 3 (single IOPub write) | same bare shape | same as arm 2 (it is also a reply refusal) |
| 4 (reply, DEFAULT cap) | `FRAME_TOO_LARGE: frame of 13118726 bytes exceeds the limit` | `... 1 frame(s) LOST; ...; declared 13118726 bytes, limit 4194304 bytes; the cell ran ...` |
| 5 (late frame, pump) | `transportDroppedFrames` 0, loss only in a log line | `transportDroppedFrames: 1` — readable through `host.status()` |
| 6 (readability) | present at runtime, absent from all host types | declared on `KernelStatus`; `arm6_tallyDeclaredInHostTypes: true` |

### Fail-hard is preserved

The refusal still fails the cell and still raises `KernelTransportError`. This
adds the count to the failure; it does **not** convert it into a success carrying
empty output — which is the exact failure mode clause 2 names. Asserted as a
control (`refusalIsStillAnError`).

---

## 3. Display: why it shares stdout's counter rather than getting its own

The coordinator asked me to state this plainly, so:

**Display does not lose FRAMES, so a dropped-frame counter is the wrong
instrument for it — and I measured that rather than accepting it.** Arm 7: two
display payloads of 256 KiB each, against a 64 KiB per-entry limit. Result:
`displayEntries: 2`, `displayTruncatedFlags: [true, true]`, both 65,536 bytes.
`_absorb_display` (`broker.py:573-591`) truncates each entry and sets that entry's
own `truncated` flag; it never drops one. So the loss a display entry can suffer
is already reported per entry, by that entry's own flag, and a second
`droppedFrames` for display would be a counter that can never legitimately exceed
zero.

**But display losses were still uncounted in the case that matters, and that is
the reply.** Arm 4's 13 MB reply is almost entirely display, and when that reply
is refused the whole delivery is lost. That loss is now counted — by the reply
path (§2), which counts the refusal, not by a display-specific counter. So the
number describes the loss without inventing a second population to count.

**Where the count does NOT go, stated because a reader must not infer it:** the
reply path counts into the broker-level tally, not into
`CellResult.stdout.droppedFrames`. On that path the cell COMPLETED and its result
exists; the per-cell sink is gone by the time `encode_frame` refuses the reply
(`execute` clears it in its `finally`), so there is no `CellResult` left to carry
the count. The tally is the only place the fact survives, which is why it exists.
The two populations are complementary and **must not be summed**: a frame refused
while a cell is in flight is charged to that cell's stdout, and the tally is the
other half.

---

## 4. The gate

`node packages/dsh-ipython/node_modules/vitest/vitest.mjs run packages/dsh-ipython/src/v3-spec-gates.test.ts --reporter=default`

**12/12 pass.** The IPY-15 arm now reports:

```
noteDroppedFrameDefinitionCount: 1        (was 0)
refusalNamesTheLoss: true
refusalStatesTheCount: true
refusalIsStillAnError: true               (control)
refusalEventCarriesCount: true
negativeCountRejected: true               (control)
brokerHasOneLossSentence: true
normalCellDroppedFrames: 0                (a normal cell loses nothing — not in tension)
```

**Mutation-tested, not assumed.** I reverted the reply to bare `str(exc)` and
re-ran: the gate went RED (`refusalNamesTheLoss`/`refusalStatesTheCount` false,
`AssertionError` at line 1411), then I restored the file. An assertion that cannot
fail is not an assertion.

No assertion was deleted and no bound was loosened. The pin that said
`expect(noteDroppedCallSites).toBe(0)` had already been inverted to
`toBeGreaterThan(0)` by the coordinator's fix, and its own comment asked for
exactly that.

---

## 5. Claims I am NOT making

1. **Not** claiming libzmq refuses anything on this transport. Measured (arm 3): a
   4,198,721-byte IOPub write is delivered WHOLE. `note_dropped_frame`'s old
   docstring said "a frame libzmq refused" — that premise is false, and I rewrote
   the docstring rather than leave a false reason attached to a true count. The
   refusal that is real is our own `encode_frame`.
2. **Not** claiming the model sees prose for a LATE-frame loss. Arm 5's loss is
   recorded in `transportDroppedFrames` and readable through `status`; it is not
   turned into text in a later cell's output. Whether a late-frame loss should
   also be spoken to the model is a product decision the clause does not name, and
   I left it open rather than assert it.
3. **Not** claiming the broker's exit on a declared-over-limit frame is wrong. A
   frame whose declared length exceeds the bound leaves no trustworthy next
   boundary, so abandoning the stream is correct.
4. **Not** claiming `droppedFrames` is populated on ordinary cells. It stays 0,
   and that is correct: a normal cell loses no frames.
5. **Not** claiming the connection file is in a per-session directory, or that
   `0o666` means world-readable on Windows. Unchanged from S6's findings.

---

## 6. Evidence

- `qualification/results/C1-ipy15/after/output-loss.json` — all seven arms, AFTER.
- `qualification/results/C1-ipy15/before.json` — the BEFORE half (arms A–D),
  captured by the coordinator's inherited c1 attempt.
- Driver: `packages/dsh-ipython/src/c1-ipy15-output-loss-measure.ts`
  (`node src/c1-ipy15-output-loss-measure.ts` from `packages/dsh-ipython`).

## 7. Commits

```
3467498  declare transportDroppedFrames on the host's KernelStatus
3e8a459  AFTER measurement -- arm5/arm6 loss IS recorded, arm2/3/4 reply still carries none
44d9256  the refused REPLY reports the loss with a count, on the reply itself
3e17303  assert the NEW truth in the gate, with controls that can fail
```

Base: `cand-round3` (`82ac3ee`), which already carried the coordinator's pump fix
(`e7e33d0`) and reply-tally fix.
