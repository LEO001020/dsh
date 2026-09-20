# V3 ROUND 2 — SHARED BRIEF FOR EVERY WRITER

Read this in full before touching anything. It is the common half of every
writer's instructions; your own assignment is in the message that sent you here.

Round 1's brief (`v3-remediation-brief.md`) still applies for the product
contract, the defect class, evidence discipline and the spec-as-oracle rules.
**Read that one first.** This file adds only what is different in round 2.

---

## 0. WHERE WE ARE, MEASURED

Round 1 merged eleven writers into `integrate-test` at `D:\DSH\work\wt-integrate`.
On that merged tree, measured:

- `dsh-daily-work` typecheck (tests INCLUDED) — **0 errors**
- `dsh-ipython` typecheck — **0 errors**
- `dsh-daily-work` suite — **53/53 files, 1357 passed + 1 expected fail, 0 red**
- `dsh-ipython` suite — **123 passed, 0 red** (2 arms fail only under full-suite
  parallel load and pass in isolation; see §4)
- Deployment identity: recorded `0a0996f3…`, recomputed **`533c8cb0…`** —
  exactly 2 inputs moved (`host_profile_digest`, `agent_preset_digest`), both from
  intentional merged work. The lock has NOT been updated yet; that is a round-2
  task.

The 13 v1 FAILs (`ID-01, ID-05, ID-06, CMP-02, CMP-04, IPY-13, IPY-15, BR-07,
DATA-09, DATA-11, REC-09, REC-10, CAP-10`) are addressed by round 1 but **not yet
re-judged under v2**. Round 2's job is to re-judge them honestly and to finish the
product.

---

## 1. THE ONE NEW AUTHORIZATION, AND ITS HONEST BOUNDARY

The user has authorized: **"把 dsh 的原生模式都删掉，只留下我们自己这一个模式"** —
delete DSH's native modes, keep only our single mode.

**Read this carefully, because the literal reading is impossible and the honest
reading is narrower than it sounds.**

"模式" in DSH is overloaded across FOUR unrelated mechanisms, and reconnaissance
mapped all four:

| sense | mechanism | where it lives |
|---|---|---|
| agent preset | `presets/<id>/agent.cordis.yml` + `preset.yml`; UI labels `标准模式`/`PTC模式`/`极简模式`/`创造模式` | `packages/preset/agent-presets/presets/` — **in the pinned checkout** |
| shipped profile | `PROFILE_TEMPLATES` = `web`/`headless`/`sdk`/`sdk-minimal`/`acp` | `packages/boot/app-boot/src/profile.ts:135` — **in the pinned checkout** |
| sandbox mode | `SandboxMode` = `read-only`/`workspace-write`/`danger-full-access` | `packages/sandbox/sandbox/src/index.ts:29` — **in the pinned checkout** |
| tool presentation mode | `ToolPresentationMode` = `native`/`ptc`/`both` | `packages/core/tools/src/index.ts:653` — **in the pinned checkout** |

**We may NOT edit the pinned checkout.** Case **ID-06**'s oracle is that
`D:\DSH\src\dsh-src` is unmodified (`git status --porcelain` + `git rev-parse
HEAD`). Editing it would trade one FAIL for a worse one and would make the whole
qualification meaningless. So "delete" here can only mean:

**STOP EXPOSING THEM FROM OUR OWN COMPOSITION.** That is a real, sufficient, and
verifiable change: our profile's `agent-presets` row currently sets
`includeShippedRoot: true`, so the live roster is FIVE presets
(`standard, ptc, minimal, cordis, daily-standard`) — measured at
`qualification/results/M12-deliverable-surface/surface.json:73-88`. Turning that
off leaves exactly one selectable mode, ours, while the pinned checkout stays
byte-identical.

Write the boundary into whatever you produce: we removed the *exposure*, not the
upstream code. A reader must not be able to mistake one for the other.

---

## 2. WHAT ROUND 1 CLOSED, SO YOU DO NOT REDO IT

Do not re-fix these; verify them only if your assignment says so.

| defect | fix | evidence |
|---|---|---|
| F3 (mode was `workspace-write` while claiming trusted-local) | explicit `sandbox-policy` row, `mode: danger-full-access`, plus a `no-sandbox-contract` guard at 3 boundaries | `qualification/results/R1-trusted-local/` |
| F4 (duplicate module instance / `src` deep import) | store takes the mounted `ctx.attachments` capability | `packages/dsh-daily-work/src/no-src-imports.test.ts` |
| F5 (target over-admission) | `tryReserveAdmission` inside ONE storage-domain update | `f5-admission.test.ts` 20/20 |
| F1 (run creation had no human authorization path) | `authorization.ts` + `/work` command path | `qualification/results/R4-authorization/` |
| F2 (BridgeServer unreachable from the product) | wired through `kernel-plugin.ts`; composition-tier boot reached a live bridge on port 4191 | `qualification/results/R5-bridge/` |
| F6 (cursor was a bearer token across stores) | durable store realm, bound as a SIGNED cursor field | `data11-cursor-realm.test.ts` 32/32 |
| F7 (conflated taxonomy) | `ProjectionManifest` split, schema v1→v2 | `qualification/results/R8-taxonomy/` |
| F8 (REC-09/REC-10 claimed a guarantee the code did not provide) | the epoch/settlement machinery was DELETED; v2 stops claiming it | `qualification/results/R9-recovery-topology/` |
| F10/F11 (typecheck false pass) | `tsconfig.check.json` includes tests; root `pnpm typecheck` | `helpers/typecheck.mjs` |

---

## 3. EVIDENCE DISCIPLINE (unchanged, restated because it is the whole game)

1. **Run it. Do not reason about it.** A claim in a report must have a command
   and its output. "The code does X" is not evidence; the run that shows X is.
2. **A control arm or the measurement is worthless.** Every check needs a case
   that must FAIL when the thing is broken. A guard that never fires and a guard
   that is absent produce identical evidence.
3. **Mutation-test your own gate.** Break the production code deliberately, show
   the gate goes red, restore. Round 1 found a `String.includes` scan that
   reported a LIVE function as deleted, and a hardcoded `false` logged as a
   measurement. Both passed their own tests.
4. **Distinguish "not measured" from "measured zero".** Report `NOT_RUN` with a
   reason rather than a comfortable default.
5. **A passing test you did not watch fail is not evidence.** If you add an
   assertion, show the run where it fails first.
6. **No credential may be printed, logged, or committed.** Not redacted-looking,
   not truncated — not printed. Do not read other accounts' data.

---

## 4. HOW TO RUN TESTS WITHOUT STRESSING THIS MACHINE

Fifteen writers share this box. Obey all of these:

- **ONE test file at a time.** `node node_modules/vitest/vitest.mjs run src/<one>.test.ts`
- **Never the whole suite.** If you believe you need it, ask the root agent.
- **No `--pool` overrides, no watch mode, no repeated loops.** A `for` loop of
  test runs is how a machine stops responding.
- **Do not spawn your own subagents.** You are a leaf. Recursion is forbidden.
- Measured: two arms (`bridge-seam.test.ts` T7-03, `r5-product-bridge.test.ts`
  J4/J5) fail under full-suite parallel load and pass in isolation. That is a
  load artifact, not a defect — but it is also the reason for the discipline
  above. If you see a failure, re-run that ONE file before believing it.

---

## 5. ISOLATION (unchanged; the recipe is in `helpers/new-writer.ps1`)

One worktree + branch + `DSH_HOME` + junction farm + profile per writer. Your
provisioning message gives you the exact paths.

- Narrow `git add <paths>`. **NEVER** `git add -A`, `git add .`, `git reset
  --hard`, `git commit -a`, or `git commit --amend`.
- Never write into another writer's worktree, and never into the MAIN tree
  `D:\DSH\work\dsh-native-daily`.
- The pinned checkout `D:\DSH\src\dsh-src` is READ-ONLY. Never write there.
- Do not `push`. Do not deploy. Do not touch `docs/GAPS.md` unless your
  assignment says to.

---

## 6. REPORT SHAPE (exactly this, so reports can be compared)

```
SLICE: <id> — <one line>
worktree/branch: <path> / <branch>
commit(s): <sha> <subject>   (one per line)

WHAT CHANGED: <file> — <why, per file>
SOURCE_FACTS: <what the pinned checkout actually does, with file:line>
TEST_RESULTS: <command> -> <N passed / M failed>   (one per line)
BEFORE/AFTER: <artifact paths, or "not applicable: <why>">
PRODUCT REACHABILITY: <the shortest real path from a boot to this code, or
                      "NOT REACHABLE: <why>" — this is the field that matters>
PASS / FAIL / BLOCKED / NOT_RUN: <per item, with the reason>
UNRESOLVED UNKNOWNs: <what you could not establish, numbered>
CLAIMS I AM NOT MAKING: <the over-reads a careless reader could take>
```

The last three fields are not optional and not decoration. Round 1's most useful
reports were the ones that said what they had NOT shown.

---

## 7. EXIT CONDITION

You are done when the assignment's oracle is satisfied **and** you can name the
command that shows it, **and** you have tried to break your own result. Not when
the tests pass — tests pass for wrong reasons constantly in this project. That is
the single most-recorded fact in `docs/GAPS.md`.
