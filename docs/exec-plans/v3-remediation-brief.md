# V3 REMEDIATION — SHARED BRIEF FOR EVERY WRITER

Read this file once, in full, before touching anything. It is the common half of
every writer's instructions. Your own assignment is in the message that sent you
here; this file is what stops ten writers from each inventing their own rules.

Source of authority: `C:\Users\hzq00\Downloads\DSH_TRUSTED_LOCAL_MASTER_PROMPT_V3.md`
(the V3 master prompt). Where this brief and V3 disagree, V3 wins — and say so.

---

## 0. WHERE WE ARE

`NOT_READY`. 109 mandatory cases filed: **95 PASS / 13 FAIL / 1 BLOCKED_EXTERNAL /
0 NOT_RUN**, under deployment identity `0a0996f3…`.

The 13 FAILs are NOT "13 red lights to turn green". They are ~12 defect clusters
of three different kinds, and the V3 audit's central instruction is:

> Do not repair case-by-case. Build a **qualification v2 + runtime repair**, and
> preserve v1 whole as immutable audit evidence.

Three classes, and you must know which one you are touching:

1. **Product-unreachable** — the mechanism exists, is unit-tested, is correct, and
   nothing in the product calls it (F1 run creation, F2 BridgeServer, F3 mode).
2. **Silently wrong** — the system runs and reports health while being incorrect
   (F4 duplicate module instance, F5 target over-admission, F6 cross-store cursor,
   IPY-13 mis-attributed output). These are worse than missing features.
3. **Qualification's own modelling errors** — F7's conflated taxonomy, F8 possibly
   verifying a topology the product does not have, F9's self-contradictory spec,
   F10's ambiguous typecheck gate, F11's mixing of checkout cleanliness into
   artifact identity.

For class 3 the correct action is often **redefine or delete**, NOT implement. An
invariant that v2 does not claim is honest; a producer invented to satisfy an old
oracle is a fabrication.

---

## 1. THE PRODUCT CONTRACT — DO NOT NEGOTIATE

1. Windows trusted-local. The **OS user account is the execution authority
   boundary**. No security sandbox in final daily.
2. No WSL, Linux VM, SSH execution world, AppContainer, or second execution OS on
   the critical path.
3. **Persistent IPython is the primary and only general programmable model
   execution surface.** `pwsh` and `bash` are not model-facing in the daily preset.
4. DSH stays authoritative for: AgentLoop and turn/step semantics; Session and
   persistence; ToolRuntime and tool schemas; filesystem; web; SessionQuery;
   attachments/artifacts; Jobs; continuable subagents; verification/evidence;
   request/usage accounting.
5. **Strong model owns semantic strategy** (decomposition, which research, which
   child gets what, when evidence suffices, when work is done).
6. **Runtime owns only mechanical facts** (authorization edges, admission,
   capacity, budget reservations, lifecycle, durable identities, effect/recovery
   facts, provenance, verification, crash reconciliation).
7. Hard live **continuable** child capacity = **30**. User target `N ∈ [1,30]`.
   Root is NOT counted as a child.
8. No alternate model path may bypass the managed target: no one-shot/background
   child spawning outside WorkService.

**NEVER create:** a second AgentLoop; a Planner→Executor→Reviewer state machine;
standing semantic roles; a global semantic task DAG; an autonomous memory
controller; a second conversation database; a second generic tool registry; a
second generic workflow engine; a `PythonToolRegistry`.

**NEVER** use `ctx.terminalController` for model Python — that is the human Web
terminal running with system-user privilege. Model Python is `ctx.ipython`.

---

## 2. THE DEFECT CLASS YOU ARE MOST LIKELY TO REPRODUCE

This project has now recorded this defect **more than twelve times**:

> The mechanism is implemented, unit-tested, and correct — while nothing in the
> product calls it.

Before you claim anything works, answer: **what product path reaches this?** If
the answer is "a test mounts it", you have proved the module works and proved
nothing about the product. `docs/GAPS.md` G-FIX-04 states the rule: *an oracle
weaker than its scenario passes while the product is broken.*

The three recorded shapes of it:
- a setter with no production caller (`setLaunchPort`, `takeContinuation`);
- a package with no `dsh.bundle` that can never reach the model;
- a row that is MOUNTED but NOT SELECTED (`G-SEAM-52`: the ported web-search
  provider exists, its tests pass, and `ctx.web.search()` reaches a different
  backend because the selection string names another id).

So: **check by CALLING the seam, not by finding the row.**

---

## 3. EVIDENCE DISCIPLINE

Classify every load-bearing statement as exactly one of:

- `SOURCE_FACT` — the pinned source/test/protocol directly proves it.
- `PROJECT_FACT` — this repo's source/import/caller graph proves it.
- `TEST_RESULT` — a controlled experiment proves it for a NAMED build identity.
- `INFERENCE` — an engineering conclusion derived from established facts.
- `UNKNOWN` — not yet verified.

Never convert: a unit test into a product-reachability claim; "module exists" into
"product uses module"; `tsc` success into runtime integration; a timeout/lost reply
into effect failure; "not significant" into equivalence; a model statement into a
mechanical receipt; a Session-log fact into model visibility without a request
manifest.

**Every claim carries the identity it was measured under.** An installed artifact
is not the repository until proven built from it — this project filed two FALSE
findings (G-SEAM-29, G-SEAM-36) by measuring a stale built `lib/` and a hand-built
harness. Both were retracted. Do not become the third: state which tree and which
build you measured, and prove it (see §4).

---

## 4. ISOLATION — MANDATORY, AND ALREADY BUILT FOR YOU

The previous round ran ten writers in ONE shared worktree and produced **five real
git accidents** (G-SEAM-35, G-SEAM-42): a `reset --hard` orphaned a commit; a
`commit -a` swept a sibling's fix; an `--amend` raced; a broad `git add` pulled in
in-progress work; an uncommitted filing was reverted. V3 §T/R9 makes worktree
isolation mandatory. **Do not repeat it.**

### Provision your writer (once, first thing)

```sh
cd /d/DSH/work/dsh-native-daily
powershell -NoProfile -ExecutionPolicy Bypass -File helpers/new-writer.ps1 -Name <yourname>
```

This creates and PROVES, in one step:
- worktree `D:\DSH\work\wt-<yourname>` on new branch `wt/<yourname>`
- the `@deepseek-ai` junction farm plus `@types/node`, `zod`, `vitest`
- a BUILD of both packages (`lib/` is gitignored, so a fresh worktree has none)
- DSH_HOME `D:\DSH\home\<yourname>`
- an installed profile whose `link:` targets are rewritten at YOUR worktree, and a
  check that Node resolves both extension packages to YOUR tree

It refuses to report success otherwise. **Work only inside your worktree.** Commit
there. The root agent integrates.

### Boot your tree as a real product

```sh
export DSH_HOME='D:\DSH\home\<yourname>'
node /d/DSH/src/dsh-src/apps/cli/lib/bin.js --profile daily --no-open --port 0
```

`--port 0` lets the OS pick a free port, so ten writers cannot collide. Port
collisions here have already produced a boot that LOOKED like a composition
failure (`EADDRINUSE` → `2 required plugins did not activate`) and cost an
investigation.

### Git discipline — prohibitions are absolute on any shared/integration branch

NEVER: `git reset --hard`, `git commit -a`, `git add -A` / `git add .`, `git commit --amend`.
DO: narrow `git add <exact paths>`; inspect `git diff --cached`; commit your own
files only; one commit per coherent change.

### CPU — the user's standing instruction

**No recursion. Do not stress the CPU.** Specifically: do not spawn your own
subagents; run test files one at a time (never two `vitest` runs concurrently);
prefer `vitest run <one-file>` while iterating and the full suite once at the end;
do not run builds you did not change.

---

## 5. EXACT-SOURCE CONSTRAINTS RE-VERIFIED AT THIS PIN

Pinned upstream: `deepseek-ai/deepseek-harness` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
(`0.1.6-alpha.2`), checkout `D:\DSH\src\dsh-src`.

These were re-checked against the exact source. If your checkout differs, record
the exact source evidence and adapt — do not assume.

1. `ctx.tools.execute(input)` is public and runs ONE complete ToolRuntime call
   through pre-policy → guards → body → post-policy → final result observers.
2. `ToolRunContext` provides `deferContext(...)`, `concludeTurn()`, an opaque
   `token`, and the exact Agent/rootCallId/callId/signal.
3. `ctx.tools.executionMode(input)` is public but is only a **classifier**
   (`parallel | exclusive`). It is NOT a barrier.
4. **Native AgentLoop/PTC do NOT get sibling-call concurrency merely by calling
   `ctx.tools.execute()` concurrently.** They coordinate ordered pre/post stages
   through a scheduler.
5. That scheduler capability is **NOT a public downstream seam**. **Do not import
   or use `TOOL_RUNTIME_SCHEDULER`** — it is a module-local `Symbol()`, and a
   second physical copy of the package makes it undefined (upstream Discussion
   #6529 records exactly this crash).
6. Current PTC queues subcalls, serializes ordered prepare/commit stages, overlaps
   only concurrency-safe bodies, forwards nested `additionalContexts` and
   `concludesTurn`, and drains owned subcalls before the outer result settles.
7. `ctx.commands` is a **human** command registry: execution does NOT send the
   command to the model, `CommandRuntime` receives the exact Agent, and it logs
   command lifecycle with `source.kind = user`. This is the preferred seam for
   human run authorization.
8. `ctx.attachments` publicly supports streamed verbatim file storage and reads
   (`saveFileStream`, `readFileStream`). **Do not private-import
   `attachment-local` store internals.**
9. `ctx.fs` publicly supports `streamText`, `readBytes`, `readByteRange`, and
   atomic write/edit — so bulk data-plane reads do not need the model-facing `read`.
10. `ctx.web` is the public provider-selecting search/fetch seam.
11. `ctx.sessionQuery.observeSession(...)` can retain ONE exact immutable Session
    cut — use the observation lease/watermark instead of re-loading a growing log.
12. `dsh-subagent.maxActiveSubagents` caps the **continuable** pool. **One-shot
    runs are outside that capacity.** Waiting/stopping continuable activations
    still occupy it.
13. `tool-subagent` can run one-shot OR continuable depending on config. Final
    daily must not leave a one-shot bypass around the WorkService target.
14. **CRITICAL RELEASE LIMITATION — do not write custom Session events.** Although
    the Session event envelope retains `ignorable?: true` for persistence
    compatibility, public `Session.append(type, data, ...)` at THIS pin does NOT
    expose an `ignorable` option for an out-of-repo non-surface plugin event.
    Therefore a downstream plugin **MUST NOT** append custom durable Session event
    types (`ipython/native-call-*`) on the assumption it can mark them ignorable.
    Do NOT misuse `tool/ptc-dispatch-*` or `feedback/record` for this either. Use
    the existing project storage-domain ledger + Artifact refs instead.

### DSH facts that repeatedly bite in this repo

- **A patch replaces the whole `config` object**; it is not a deep merge
  (`vendor/include/src/index.ts:120-123`). Restate every key you need, or the rest
  silently revert to schema defaults.
- **`ctx.get('x')` vs `ctx.x`**: the latter throws without a static `inject`.
- A tool row belongs in the **agent preset**, not the profile patch: `ctx.tools`
  layers are keyed by the Agent object, so a host-level tool row publishes into
  the root realm where no agent's scope sees it.

---

## 6. THE SPEC IS AN ORACLE, NOT A SUGGESTION

`qualification/specs/acceptance-spec.trusted-local-v1.json` is the 109-case
ledger. `qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json`
is the as-authored snapshot (hashes to the pinned
`e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7`).

**v1 is frozen. You may not edit it.** Its contradictory oracles stay contradictory
on purpose: the contradiction is evidence that the spec and the deployment
diverged. Do not "repair" `28 → 27` or `present → absent`.

**Label collision — a trap that has already cost this project time.** Pre-spec test
labels (`IPY-15`, `FS-06`, `VER-09`) are NOT the spec's case ids. **Map by ORACLE,
never by label.** Two different oracles can share a label; one oracle can span
several.

**Forbidden, absolutely:** obtaining a PASS by editing an oracle, skipping a test,
lowering N, widening permissions, or reporting a result you did not measure.
`NOT_RUN`, `FAIL` and `BLOCKED_EXTERNAL` are not PASS.

---

## 7. YOUR SLICE'S EXIT CONDITION

V3's completion rule, applied to your slice:

> A phase finishes only after its **product entry point** and its
> **negative/fault tests** are demonstrated through the **assembled daily
> composition**.

Not "the code compiles". Not "the unit test passes". Not "the mechanism works in
isolation". If your change cannot be reached by the product, say so plainly and
record it — an honest `BLOCKED` beats a fabricated PASS.

Archive the OLD reproduction BEFORE you change the behaviour, so the before/after
pair is on disk.

---

## 8. REPORT BACK IN THIS SHAPE

Keep it short and factual. The root agent reads this to decide what to do next.

```
SLICE:            <your assignment id and one line>
worktree/branch:  D:\DSH\work\wt-<name>  /  wt/<name>
commit(s):        <sha> <subject>

WHAT CHANGED (files, with why):
SOURCE_FACTS:
PROJECT_FACTS:
TEST_RESULTS:     <exact command> -> <exact observed outcome>
                  identity measured under: <which tree/build, and how you proved it>

BEFORE/AFTER:     <the archived old reproduction vs the new behaviour>
PRODUCT REACHABILITY:  <which real product path reaches this change>
FAULT/NEGATIVE TESTS:  <what you injected and what failed as required>

PASS / FAIL / BLOCKED / NOT_RUN:
UNRESOLVED UNKNOWNs:
CLAIMS I AM NOT MAKING:
```

`CLAIMS I AM NOT MAKING` is not decoration. It is the field that has caught this
project's worst over-claims, and leaving it empty is treated as a claim that there
are none.

---

## 9. IF YOU FIND SOMETHING OUTSIDE YOUR SLICE

Do not fix it silently and do not expand your slice. Record it in your report with
the exact evidence, and message the root agent. Several of this project's most
valuable findings (G-SEAM-45, G-SEAM-47, G-SEAM-52) came from a writer noticing
something adjacent while measuring its own slice.

If your causal explanation is later falsified: **retract the explanation, keep the
raw observation.** `G-SEAM-36`'s restart-timing variance (1823 ms vs 11852 ms) is
still real and still `UNKNOWN_CAUSE` even though the first explanation was wrong.
Do not delete a real phenomenon because your first theory of it failed.
