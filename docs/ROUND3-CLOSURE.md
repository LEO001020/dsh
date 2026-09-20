# Round-3 closure — what changed, what it cost, and what is still open

**Published:** `https://github.com/LEO001020/dsh` at `82ac3ee`, a **fast-forward** from
`2e1b2c2` (not a force-push). 596 commits, ~1980 tracked files.

This document is the honest state at that commit. It is written for a reader who wants to
know what they can rely on and what they cannot.

---

## 1. The release gate: 13 FAIL → 4 FAIL, blockers 4 → 1

| check | before | after |
|---|---|---|
| 1 verify-spec passes | FAIL, 317 problems | FAIL, 315 problems (see §4 — reported, not blocking) |
| 2 identity is fresh | FAIL — lock `533c8cb0` vs tree `152e5c45` | **ok** |
| 3 no FAIL | FAIL — 13 cases | FAIL — **4 cases** |
| 4 no FLAKY | ok | ok |
| 5 no NOT_RUN among mandatory | ok | ok |
| 6 no INVALIDATED | ok | ok |
| 7 no stale evidence | FAIL — 3 references | **ok** |
| 8 only allowlisted BLOCKED_EXTERNAL | ok | ok |
| 9 post-integration assembled-product evidence | FAIL — 0 of 61 | **ok** — 3 of 64 |

**Verdict: `NOT_READY`, one blocker: 4 mandatory cases failed.** Three of those four are
recorded non-defects (§3).

## 2. The nine cases that moved, and the measurement behind each

| case | what the recorded FAIL said | what was measured |
|---|---|---|
| **ID-06** | the pinned checkout is dirty | the "dirt" was a **CRLF artifact**: the HEAD blob is 7086 bytes of pure LF, the worktree file was 7251 bytes of pure CRLF, and the difference is exactly 165 bytes — one per line. `git hash-object` equalled `git rev-parse HEAD:<path>`. `.gitattributes` mandates `eol=lf`; `core.autocrlf=true` is the host's global override. Normalised the working tree: no committed content changed, HEAD did not move, `git status` is now empty |
| **ID-01** | one `@deepseek-ai/*` specifier resolved outside `lib/` | **the boot measured a different checkout.** The offender's own recorded `parentURL` was `file:///D:/DSH/work/dsh-native-daily/...` — the main checkout, on branch `ipython-native`, which never received the fix `bcc036e`. In the qualified tree the deep import does not exist; `artifacts.ts:131` imports the public seam and the only mentions of `attachment-local` are comments. Filed as **G-SEAM-82** |
| **ID-05** | 475 non-test `as never` casts | **zero.** Two probes had independently written `apply(toolCtx as never)` — two instances of the same shape, the signal that a **seam** was missing. Added `IpythonToolMount` / `IpythonToolService` (a `Pick` of `KernelService` naming the four members `execute` reaches) and `registerIpythonTool`. Deleting the casts immediately surfaced two REAL type errors they had been hiding |
| **CMP-02** | the sandbox row resolved to `workspace-write` | **`danger-full-access`**, all three clauses, through a real boot — **with a negative control**: reverting the mode flips the same instrument to `STILL FAILS` |
| **BR-07** | the bridge route had no disposition vocabulary | the vocabulary exists and is reachable; the **original probe** re-run flips both vocabulary booleans while drain timing is unchanged. 10/10 |
| **CAP-10** | `drain` overshot the target under a completion storm | the **same V8 probe arm** that measured the defect now reads `admitted=2` against a target of 3. Storm suite adds a control, an N+2 arm, a duplicate arm and a sweep, all `overshoot=0` |
| **IPY-15** | the dropped-frame counter had zero call sites | the loss was **worse** than recorded: a 4,456,448-byte background write after its cell settled raised inside the iopub pump, whose bare `except Exception` swallowed it — 4.4 MB gone, model told nothing. The pump and the reply path now both count, through the existing `note_dropped_frame`. `noteDroppedFrameDefinitionCount` 0 → 1 |
| **DATA-09** | two stages have no producer so the clause cannot hold | the recorded reasoning **conflated stimulus with oracle**. The real defect: `captureFile` forced the shortfall to 0, so a 400-byte file read with `length: 1000` reported `complete-within-request` and `isDeliverableAsComplete: true` while 600 bytes were absent |
| **DATA-11** | a cursor yielded pages from a foreign store | the named arms already held; the **harm** was still reachable because the identity memo stamped on `(size, mtimeMs)`, both attacker-settable. Adding `ctimeMs` closes it. The before-arm reproduces the **exact digest the audit archived** (`cc7321cc…`) |

**Two cases were re-measured and deliberately kept FAIL**, which matters as much as the
passes: **CMP-04** is a genuine spec contradiction (the supersede option has already been
exercised — the v2 definition records it as `rewritten`), and **IPY-13** fails on a WORD
(the oracle requires `undecidable`; the product reports `known-late` with a true origin,
which is arguably better and still not what the oracle names).

## 3. The four remaining FAILs

| case | status | why it is not a product defect |
|---|---|---|
| `CMP-04` | permanent by design | the oracle and CMP-13's cannot both hold for one catalog. Verified real, not a measurement artifact, three ways. The corrected contract already exists as the v2 definition |
| `REC-09` | permanent by design | **the guard was DELETED, not left unwired** (G-SEAM-21): its input cannot be constructed on any production path. Two tests enforce the deletion. Wiring it would mean manufacturing a caller |
| `REC-10` | permanent by design | same deletion; this case asks for reachability of something that no longer exists |
| `IPY-13` | literal clause | the recorded defect is gone and the product's behaviour is better than the oracle asks. An oracle is not satisfied by a better outcome it did not anticipate |

## 4. What is NOT cleared, stated plainly

- **315 verify-spec problems**, all but one an identity-stamp mismatch. **These do not
  block the gate** — check 1 records them as a check and appends no blocker, deliberately.
  I did **not** re-stamp the 314 entries: `0a0996f3` is a real entry in the lock's own
  `identity_history`, so re-stamping would assert that a measurement was taken against the
  current artifact when it was not. The honest remedy is re-measurement, which is what the
  nine cases above did. Read the 315 as **a work list, not a defect list**.
- **The 112-case acceptance authority is still `ALL_NOT_RUN`.** Its inventory is at
  `qualification/results/C9-coverage/COVERAGE.md`: **76 COVERED, 25 PARTIAL, 5 UNCOVERED,
  6 BLOCKED_EXTERNAL**. Six blocked split into four needing a live provider budget the user
  does not have and two needing a provisioned world (no SSH execution world; one
  read-permission domain where two are required).
- **No paid evaluation, no real 30-child provider run, no vendor benchmark.** The largest
  real N measured is 10 on a scripted adapter. `CAP-08` is the only authority case whose
  text names 30, and it is not satisfied by a smaller N.
- **The `?token=` redaction is complete in the tree** (63 occurrences across 61 files, zero
  remaining) but **three history-only blobs still carry tokens**. Rewriting them would
  change every downstream SHA and invalidate the identity and every filed verdict. Recorded
  as a trade not worth taking, not overlooked.
- **`.github/workflows/post-integration.yml` has never executed.** There is no runner and no
  network authorization to add one, so it is unvalidated YAML — a claim about what CI would
  do, not evidence that it does it. Its own header says so.

## 5. The two findings that generalise

**G-SEAM-81 — a cleanliness oracle defeated by a host setting.** `core.autocrlf=true` made
a byte-identical tree report as modified. `check-source-plane.mjs` classifies this correctly
as `EOL_STAT_DIRTY` and deliberately refuses to excuse it, because an excuse for EOL must not
also excuse a real modification. That refusal is right, and its consequence is that the check
reports a defect against a tree that is not defective.

**G-SEAM-82 — a recorded FAIL can be a true statement about the wrong checkout.** This is
worse than the stale-build trap: a stale build produces a wrong *number*, while a stale tree
produces a wrong *verdict* that survives review, because the verdict's own prose said "the
BUILT artifact, so this is the product's path" — and a reader checking that sentence would
agree with it. The path was in the evidence all along and nobody read it **as a path**. The
general rule: a graph or boot measurement must assert that every resolved parent path lies
under the tree it claims to measure.

## 6. What I got wrong, recorded

- **I marked IPY-13 PASS, then reversed it** after writer c7's independent probe showed the
  gate only asserted the weaker property. The gate was an oracle weaker than its scenario.
- **My serial test suite had a harness defect.** Four "failures" I reported were mine: I ran
  vitest from the repo root, and the tests spawn children with `cwd: process.cwd()` so they
  resolve `tsx` through the package's `node_modules`. From the package directory the same
  file is 33/33. The four were never product failures.
- **My first IPY-15 fix wired the pump and missed the reply path.** Writer c1 found it. Fixed
  in `82ac3ee`.
