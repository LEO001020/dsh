# V5 ROUND 3 — SHARED BRIEF FOR EVERY WRITER

Read in full before touching anything. Round 1's brief
(`v3-remediation-brief.md`) still governs the product contract, evidence
discipline and isolation recipe. Round 2's (`v3-round2-brief.md`) governs the
one-test-file-at-a-time CPU discipline. **Read both, then this.**

Source of authority: `C:\Users\hzq00\Downloads\DSH_FINAL_CODE_AUDIT_EXECUTION_PROMPT_V5.md`
(V5). Where this brief and V5 disagree, V5 wins — and say so.

---

## 0. THE V5 VERDICT, AND WHAT IT MEANS FOR YOU

An external audit re-read the **published** GitHub HEAD (`2e1b2c2` at dispatch;
V5 audited `35376dee`) and concluded:

> **Architecture: converge. Implementation: close. Qualification: not closed.
> Release: NOT_READY.**

Its central instruction is **stop adding architecture**. Every P0 below is
"connect a mechanism that already exists", not "design a new one". If you find
yourself designing a second controller, a second socket, a second registry, or a
second model loop, **stop** — that is the failure V5 names explicitly.

V5 also **withdrew its earlier D-1 fix advice**: the store-scoped CSPRNG key now
in the tree is the right design (a process-memory key would invalidate every live
cursor across a restart, and restart-survival is a product requirement). **Do not
re-architect D-1.** Only its security *claim* needs narrowing.

---

## 1. THE 15 FACTS I MEASURED BEFORE DISPATCHING

V5 §24 asks for these. All were measured on `2e1b2c2` by the root agent; each
writer should re-verify the ones in their slice rather than trusting them.

| # | question | measured answer |
|---|---|---|
| 1 | local + remote HEAD | both `2e1b2c2d3657407ce7ac621b07b3307d3edd8df4` |
| 2 | clean/dirty | 4 modified tracked (regenerable evidence), 1 untracked (`.push-gate/`) |
| 3 | pinned upstream | `ddefc45fbc7f8e46dd73185e68295696d1297887` |
| 4 | D-1 attacker repro negative? | **YES** — `STORE_CURSOR_KEY_FILE_NAME` present; my old forgery refused |
| 5 | model-facing tool catalog | 27 names, `ipython` present, `pwsh`/`bash` absent |
| 6 | Python env manifest | **WEAK** — `sha256(pythonExecutable + platform + arch)`, 16 hex chars |
| 7 | `dsh.data` routed in `onCall`? | **NO** — `grep -c 'data:' bridge.ts` = **0** |
| 8 | `verify-spec --summary` early return? | **YES** — `:108-119`, `return 0` before all validation |
| 9 | direct child-creation visible? | **YES** — `tool-subagent`, `tool-subagent-fork` mounted |
| 10 | completion auto top-up? | **NO** — `subagent/end` has no listener in production |
| 11 | `drainUnattributed` product consumer? | **NO** — only `kernel-plugin.ts:760` (definition) and a probe |
| 12 | durable ledger silent fallback? | **YES** — `opened?.ledger ?? new MemoryBridgeLedger()` at `:540` |
| 13 | waiter registered before send? | **NO** — `_send()` at `:1526` sends, `:1529` registers |
| 14 | `CellLease.invoke` publishes before ledger? | **YES** — `byRequestId.set` `:542`, `queue.push` `:543`, `inFlight.add` `:544`, **then** `await ledger.started` `:551` |
| 15 | `pending` double-counts? | **YES** — `:477` is `inFlight.size + queue.length`, and queued calls are already in `inFlight` |

---

## 2. FILE CONTENTION — READ THIS BEFORE YOU EDIT

**Three files have multiple writers this round.** Separate worktrees mean no
corruption, but a careless merge drops a fix. Obey your region:

### `packages/dsh-ipython/src/bridge.ts`

| writer | your region |
|---|---|
| **P2** | the EMBEDDED PYTHON CLIENT: `_send`, `call_sync`, `call_async`, `_waiters` |
| **P3** | `CellLease.invoke`, `pending`, the accepted-call state machine |
| **P4** | `onCall` dispatch and the routing branch only |

### `packages/dsh-ipython/src/kernel-plugin.ts`

| writer | your region |
|---|---|
| **P8** | `runCell` and the preamble/`canPrependPreamble` path |
| **P9** | `drainUnattributed` and the late-output notice path |
| **P10** | the ledger-open call site |
| **P11** | `defaultEnvironmentDigest` and the status surface |
| **P12** | `kernelRoot()` / `DEFAULT_KERNEL_ROOT` |

**Rules for every writer on a contended file:**
1. Edits SURGICAL and localized to your region. No reformatting, no import
   reordering, no "cleanup" of adjacent code — cosmetic churn in a shared file is
   what turns a clean merge into a hand-resolved one.
2. Name your changed **functions and line ranges** in your report, so the
   integrator merges by region rather than by hunk.
3. If correctness genuinely requires touching another region, **do it and flag it
   under its own heading** — correctness beats merge convenience.
4. **Commit early and often.** A 25-minute uncommitted reconnaissance that ends in
   a model error has already cost this project two slices.

---

## 3. EVIDENCE RULES (V5 §1 — stricter than round 2)

Tag every load-bearing claim: `SOURCE_FACT` / `PROJECT_FACT` / `RUNTIME_FACT` /
`TEST_RESULT` / `PAPER_RESULT` / `INFERENCE` / `UNKNOWN` /
`RETRACTED_HYPOTHESIS`.

**Never infer any of these** (V5's list, verbatim in spirit):

- module exists ⇒ product uses it
- service mounted ⇒ consumer reachable
- test file green ⇒ release gate valid
- HMAC present ⇒ the MAC secret is unavailable to the protocol caller
- **one rerun green ⇒ flaky case is stable** (this project measured 1-in-4 on
  `r5-restart-epoch.test.ts`)
- parser finds imports ⇒ runtime-resolved graph is complete (measured: a
  variable-held specifier is invisible to the parser)
- setting changed ⇒ active run changed
- child accepted ⇒ child completed
- effect timed out ⇒ effect failed
- stdout has parent id ⇒ origin is causally correct
- compiled ⇒ packaged/relocatable
- **current README ⇒ current code**

**Every release-level claim must answer two SEPARATE questions:**
1. Is the check structurally well-formed?
2. **Does it model the adversary/failure mode that can actually falsify it?**

Question 2 is the one this project keeps failing. I audited R7's cursor oracle,
called it "SAFE, and structurally so" on question 1, and D-1 falsified it on
question 2. Ask what the adversary **does not have**.

---

## 4. CPU DISCIPLINE (unchanged, and now load-bearing)

Fifteen writers share this machine. **ONE test file at a time. Never the whole
suite.** No `--pool` overrides, no watch mode, no retry loops. **Do not spawn
subagents — you are a leaf.** If you believe you need the full suite, ask the
root agent instead.

Two arms are known load-sensitive (`bridge-seam.test.ts` T7-03,
`r5-product-bridge.test.ts` J4/J5, and `r5-restart-epoch.test.ts` at a measured
1-in-4 rate). Re-run ONE file before believing a failure.

---

## 5. GIT DISCIPLINE

Narrow `git add <paths>`. **NEVER** `git add -A`, `git add .`, `git reset
--hard`, `git commit -a`, `git commit --amend`. Never write into another
writer's worktree or the MAIN tree. `D:\DSH\src\dsh-src` is READ-ONLY. Do not
push — the root agent publishes.

---

## 6. REPORT SHAPE (exactly this)

```
SLICE: <id> — <one line>
worktree/branch: <path> / <branch>
commit(s): <sha> <subject>
REGIONS CHANGED: <file>: <function> <line-range>   (required for contended files)

WHAT CHANGED: <file> — <why>
SOURCE_FACTS: <file:line of what the pinned checkout / current tree actually does>
TEST_RESULTS: <command> -> <N passed / M failed>
BEFORE/AFTER: <artifact paths, or "not applicable: <why>">
PRODUCT REACHABILITY: <shortest real path from a boot to this code, or NOT REACHABLE: why>
PASS / FAIL / BLOCKED / NOT_RUN: <per item, with reason>
UNRESOLVED UNKNOWNs: <numbered>
CLAIMS I AM NOT MAKING: <the over-reads a careless reader could take>
```

The last three fields are not optional. This project's most useful reports said
what they had **not** shown.

---

## 7. EXIT CONDITION

Done when the assignment's oracle is satisfied, **and** you can name the command
that shows it, **and** you have tried to break your own result. Not when tests
pass — tests pass for wrong reasons constantly here. That is the single
most-recorded fact in `docs/GAPS.md`.
