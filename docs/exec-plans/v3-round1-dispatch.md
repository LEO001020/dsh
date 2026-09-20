# ROUND 1 — V3 REMEDIATION DISPATCH RECORD

**Date:** 2026-09-20
**Target branch:** `ipython-native` (the integrator's branch)
**Base commit for every writer:** `a4b0838` (the shared brief)
**Baseline identity:** `0a0996f3…`, 109 cases filed as **95 PASS / 13 FAIL /
1 BLOCKED_EXTERNAL / 0 NOT_RUN**

---

## Why this file exists

Ten writers are working in ten isolated worktrees. If this session is interrupted,
a reader must be able to reconstruct **who owns what, what each one was told, and
which claim each is responsible for** — without reading ten agent transcripts. It
also records the ownership map so that a later round does not duplicate a slice
or, worse, silently drop one.

---

## The thirteen FAILs and their owners

Every one of the 13 has a named owner. This map is the answer to "did anything
get dropped?", and it is checked mechanically rather than from memory.

| Case | Owner | What closes it |
|---|---|---|
| `ID-01` | **R2-F4** | remove the production `dsh-attachment-local/src/store.ts` import; add a build gate |
| `ID-05` | **root** (deferred, decision D4) | the `as never` sweep — 488 occurrences, 478 in test files under concurrent edit |
| `ID-06` | **R2-F11F10** | clean qualification source plane; move runtime dirs out of the pinned checkout |
| `CMP-02` | **R1** | set `danger-full-access` explicitly; Session override migration; extend the contract guard |
| `CMP-04` | **root** (decision D1) | v2 redefinition — the oracle's pinned `28` encoded a composition fact |
| `IPY-13` | **root** (experiment done) → **R5** (implementation) | metadata → ContextVar → stream proxy; experiment archived |
| `IPY-15` | **root** (decision D2) | v2 redefinition; keep fail-hard; drop the dead `droppedFrames` claim |
| `BR-07` | **R5** | adopt the scope route's disposition vocabulary in the bridge |
| `DATA-09` | **root** (decision D2) → **R8** (implementation) | split acquisition from projection |
| `DATA-11` | **R7** | durable `storeRealmId`; cursor binds realm + revision + content |
| `REC-09` | **R9** | topology measurement, then fencing OR deletion |
| `REC-10` | **R9** | same decision |
| `CAP-10` | **R3** | atomic admission + one drain leader per run |

---

## The eleven writers and what each was told

All eleven read `docs/exec-plans/v3-remediation-brief.md` first. Each also got a
slice-specific prompt; the load-bearing constraints are summarised here so a
reader can tell whether a writer's report addresses what it was asked.

| Writer | Slice | Key constraint it was given |
|---|---|---|
| **R0** | freeze v1; v2 definition/result split | **Do not rename the frozen snapshot.** Its digest is a pinned identity input (`trusted_local_acceptance_spec_sha256`), so moving it breaks the pin and three verifiers. v1's contradictory oracles stay contradictory. Exit test: runtime drift and spec drift must produce **different** identity failures. |
| **R1** | F3 trusted-local policy truth | **Do not fix by deleting only the prompt line.** Both the narration and the execution fact must end truthful. A runtime mutation to non-full mode must fail LOUD, never be silently switched back. Do not remove PTC (R5 owns that). |
| **R2-F4** | F4 upstream `src/*` import | Use the PUBLIC `ctx.attachments` seam. **Do not request an upstream export.** Must decide and justify whether the gate covers emitted `lib/` only or non-test `src/` too, and enumerate every remaining deep import. |
| **R2-F11F10** | F11 clean checkout; F10 one typecheck | **Characterise before acting** — the `' M'` entry has an identical blob hash to HEAD, so it is a line-ending artifact, not content. Never `git checkout`/`reset`/`clean` in the upstream tree. Do NOT require root and check tsconfig to mean the same thing. |
| **R3** | F5 atomic admission | Correctness must live in ONE authoritative storage-domain update; the drain coalescer is efficiency only. **Never release a slot merely because cancellation was requested.** Deficit must derive from authoritative reservations, not a side-effecting counter. |
| **R4** | F1 human run authorization | **Do NOT make `work.create` a model tool as the primary fix.** `exec.agent` existing is NOT user authorization. A slider value is configuration, not authorization. Never auto-create a run. |
| **R5** | F2 production BridgeServer | **`dsh.call` is SERIAL — never run many `ctx.tools.execute()` concurrently and claim native scheduling parity.** Never import `TOOL_RUNTIME_SCHEDULER`. **No custom `ipython/native-call-*` Session events at this pin.** Reuse the existing bridge rather than rewriting it. |
| **R6** | `dsh.data` high-throughput plane | The invariant: `acquired != persisted != Python-consumed != LLM-visible`. **Do not spend unauthorized API budget** — `ctx.web.search()` currently reaches a real backend, so test at the provider level. |
| **R7** | F6 cursor / store realm | Reuse an existing durable store identity if one is real. **`storeRealmId` must survive restart** — a per-boot random id would be a restart bug dressed as a security property. Never serve bytes before verifying the descriptor. |
| **R8** | F7 taxonomy split | **Do not create fake producers for v1 vocabulary.** Intentional projection is not an acquisition gap. Keep fail-hard for oversized frames; do not degrade a refusal into a silent drop to make a counter nonzero. Handle the schema version explicitly. |
| **R9** | F8 recovery topology | **Do not wire dead `recovery.ts` merely to satisfy a case.** Build the topology graph FIRST. Both "implement fencing" and "delete the dead claim" are acceptable outcomes; inventing a caller is not. |

`R9`'s first attempt died on a model-request error before producing any work; it
was re-dispatched reusing the same provisioned worktree.

---

## Root-owned work completed in this round

Root did not only dispatch. The following are root's own commits on
`ipython-native`, all before any writer integration:

| Commit | What | Why it was root's |
|---|---|---|
| `271acff` | `link-all-dsh.ps1` links `@types/node` | The documented recreation procedure produced an **unbuildable** install. Found by running it, not by reading it. |
| `8c6eae8` | same script links bare deps (`zod`, `vitest`) | Second half of the same gap; a fresh worktree failed `TS2307`. |
| `96a0e35` | `dsh-ipython` derives broker/root from `import.meta.url` | **Blocker for the whole wave**: the bundle patch hardcoded one checkout's paths, so every worktree would have measured the MAIN tree's Python. |
| `5567498` | `new-writer.ps1` verifies by module resolution | The first version grepped a config dump for a path and **failed on a correct tree**. |
| `a4b0838` | the shared brief | Ten prompts would otherwise restate and drift. |
| `b424f14` | **IPY-13 isolated kernel experiment** | V3 §M2 requires it BEFORE choosing a fix. Reproduced the defect, found the hook, and measured that a plain thread does NOT inherit a ContextVar. |
| `733c31b` | v2 oracle resolutions (D1–D6) | Contract decisions no single writer should make alone. |
| `bc9303e` | `integrate.py` | Expected-ref CAS integration; refuses a dirty tree; aborts conflicts rather than auto-merging. |
| `2285cc7` | `rederive-identity.py` | Integration moves identity inputs; the tool reports and refuses to guess. |
| `afaa732` | `DSH_SEAMS.md`: the write chain is per-DOMAIN | The substrate fact R3's correctness rests on, recorded with its two consequences. |
| `cf77545` | `G-SEAM-59` connection-file ACL | Measured; includes **retracting** the mode-bit half of the same evidence. |
| `ecb23f8` | `G-SEAM-52` measured, fix declined | The fix is unverifiable on this machine (no credential), so it stays OPEN rather than being closed by an unmeasurable change. |
| `151e88f` | `G-SEAM-58` the `as never` idiom | Measured that one of its two forms **masks a real `TS2345`**. |
| `0703f39` | `G-SEAM-60` writer isolation verified | All ten writers build and resolve their OWN tree. |

---

## Standing constraints that apply to every writer

From the shared brief, repeated here because they are the ones most likely to be
violated by habit:

- **No recursion, no subagents, do not stress the CPU.** One test process at a
  time; never two `vitest` runs concurrently.
- **Git prohibitions are absolute:** no `git reset --hard`, `git commit -a`,
  `git add -A` / `git add .`, `git commit --amend`. Narrow `git add <paths>`,
  inspect `git diff --cached`, commit your own files.
- **v1 is frozen.** No PASS by editing an oracle, skipping a test, lowering N,
  widening permissions, or reporting a result that was not measured.
  `NOT_RUN`, `FAIL` and `BLOCKED_EXTERNAL` are not PASS.
- **Never use `ctx.terminalController`** for model Python.
- **No credential is ever printed.** Presence checks only.
