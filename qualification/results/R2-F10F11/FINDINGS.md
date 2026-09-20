# R2-F10F11 — a clean qualification source plane (F11) and ONE authoritative typecheck (F10)

Slice: **F11** (`ID-06`, G-SEAM-49) and **F10** (`ID-05`, G-SEAM-48).
Worktree `D:\DSH\work\wt-r2b`, branch `wt/r2b`.

Both findings are **qualification's own modelling errors** (V3 §0 class 3), so the
correct action for each was to *redefine the instrument*, not to make the product
stricter. Neither finding was "fixed" by weakening an oracle.

---

## 1. F11 — the pinned checkout's dirty state, characterised

### The three entries are not the same kind of thing

`git status --porcelain` in `D:\DSH\src\dsh-src` returned exactly three entries.
Measured before any action (`source-plane-before.txt`):

| Entry | Class | Evidence |
|---|---|---|
| ` M packages/deliverables/workspace-changes/src/index.ts` | **EOL_STAT_DIRTY** | `git diff --exit-code` → **exit 0** (no content delta). `git hash-object <file>` = `c05787d931870defacfdfcb4feca85f4ae733d8e` **equals** `git rev-parse HEAD:<path>`. Worktree 7251 bytes / 165 CRLF / 0 bare LF; HEAD blob 7086 bytes / 0 CRLF / 165 LF; identical after CRLF→LF **and** after LF→CRLF. |
| `?? DSHhomem914/` | **UNTRACKED_GENERATED** | 9 files, 61 KB: a DSH home (`profiles/sdk/`, two `session.v3.jsonl.zstd` under `sessions/--D-DSH-src-dsh-src--/m914-sdk*`, two `session_projcache` projections). Mtime 2026-09-19 19:04. |
| `?? data-artifacts/` | **UNTRACKED_GENERATED** | 1 content-addressed object `objects/15/150f662d…`, 162 bytes, sha256 **equals its own filename**, payload `'x'*150 + "-PROBE-TAIL\n"` — matches the probe payload at `qualification/runners/verify-data-plane.mjs:102`. Plus an empty `tmp/`. |

### The EOL entry: mechanism, not content

`git check-attr` reports `text: auto`, `eol: lf` for the file (from the checkout's
own `.gitattributes`, `* text=auto eol=lf`) while the **global** `core.autocrlf`
is `true`. The file's mtime is `2026-09-19 19:19:47`, predating this session.

The status entry survives `git update-index --refresh`, which prints
`needs update` and exits 1. That was reproduced from scratch in a throwaway repo
to confirm the mechanism is general rather than a property of this checkout:
a committed LF file with `* text=auto eol=lf` rewritten as CRLF under
`core.autocrlf=true` produces exactly ` M f.ts`, with `git diff --exit-code` exit 0
and an identical blob id.

**Nothing was done to it.** It has no content delta to discard, and clearing it
would mean writing the shared index of a tree this project does not own. The gate
names the remedy (`git add --renormalize`) and refuses to run it.

### What was moved, and where

Both untracked directories were **moved, not deleted**, because
`DSHhomem914/` holds real sessions from this project's own M9.14 work.

**Destination:** `D:\DSH\relocated\2026-09-20-checkout-state\`

Method: copy → verify → remove. Every file was hashed before the move
(`moved-state-manifest.json`, per-file sha256 + byte count), then the copy was
verified against that manifest (**10 files verified, 0 mismatches**), and only
then were the originals removed.

The manifest's paths are relative to the dated parent, so the full path of any
entry is `D:\DSH\relocated\2026-09-20-checkout-state\<path>`.

The coordinator independently re-hashed
`D:\DSH\relocated\2026-09-20-checkout-state\DSHhomem914\sessions\--D-DSH-src-dsh-src--\m914-sdk\session.v3.jsonl.zstd`
→ `c2aa1e3d4dbfff02547f06415f0a7a590f2b801b634353708ff594795a03e84d`, equal to
the manifest. Byte-identical.

### Result

`git status --porcelain` went from **3 entries to 1**:

```
 M packages/deliverables/workspace-changes/src/index.ts
```

### `ID-06` remains FAIL, and must

`ID-06`'s oracle is unconditional: *"Any tracked modification, any staged change,
or a moved HEAD is NOT PASS."* HEAD **matches**
`ddefc45fbc7f8e46dd73185e68295696d1297887`; the tree is **not** clean. The FAIL now
rests on exactly **one** entry, and that entry is a line-ending artifact with a
provably identical blob id — but the oracle does not admit that carve-out, and a
gate that quietly invented one would be a weaker oracle than the one filed.

**A future resolution would require** (neither done here):

- a qualification checkout created with `core.autocrlf=false`, or
- a `.gitattributes` normalisation of that path (`git add --renormalize`), which
  rewrites the shared index.

Both are changes to the **qualification environment**, not to the product. They
must be taken deliberately by someone who owns that tree — not as a side effect of
a gate run, and never by `git checkout`/`reset`/`clean`.

### The instrument that replaces it

`qualification/runners/check-source-plane.mjs`:

- derives the checkout from the lock's `launcher_realpath` (one place, not two);
- classifies each entry into `CONTENT_MODIFICATION` / `STAGED_CHANGE` /
  `CONTENT_DELETION` / `UNTRACKED_GENERATED` / `EOL_STAT_DIRTY` /
  `OTHER_MODIFICATION`, and prints the blob ids that prove an EOL entry;
- exits **0** clean, **1** dirty, **2** unusable — distinguishable, so a broken rig
  can never be read as a verdict about the source;
- exports `assertCleanSourcePlane()` for a caller that is about to launch.

The shared boot harness (`qualification/runners/boot-harness.mjs`) calls it when
`DSH_REQUIRE_CLEAN_SOURCE_PLANE=1`, so a boot refuses **before launch** rather than
producing a verdict on an unstateable tree. It is **opt-in** because exploratory
probes deliberately run against mid-edit trees; a run that wants a citable result
sets the variable, and one that does not cannot cite its result as a verdict.

**Git cleanliness is an ENVIRONMENT PRECONDITION, not part of the artifact
identity.** The identity is the launcher digest + lockfile + profile/preset digests
+ the resolved graph, and `helpers/doctor.py` re-derives it — that is the check
that survives a dirty checkout. Neither substitutes for the other. V3 §G2's
distinction is implemented rather than restated.

---

## 2. F10 — one authoritative typecheck

### What was wrong

No root `tsconfig.json` exists. The two per-package configs mean different things
on purpose: `tsconfig.json` is the BUILD face (`exclude src/**/*.test.ts`, so test
code never emits into `lib/`), `tsconfig.check.json` is the CHECK face (extends it,
clears only the exclude, `noEmit`). `tsc -p tsconfig.json --noEmit` therefore exits
0 with or without a test file present — a false pass.

### What was decided, and why

- **One official command: `pnpm typecheck`** → `helpers/typecheck.mjs`.
- A **root `package.json`** provides it. This was the choice because a documented
  `make`-style script would not be reachable by the reflex a reader actually has,
  and because the script uses only Node builtins, so the command works from a clean
  clone with nothing installed.
- **No pnpm workspace.** The two packages resolve `@deepseek-ai/*` through `link:`
  targets and their own junction farms; making them workspace members would be a
  **build-identity change made to satisfy a typecheck gate**. The gate needs one
  citable command, not a restructuring.
- **No root `tsconfig.json`.** A solution-style root that merely referenced both
  packages would add a config without adding coverage. The audit's judgement was
  that root/solution configs and product-check configs must **not** be forced to
  mean the same thing; the official command is what makes "one authoritative gate"
  true without collapsing the two faces.

The script covers the **complete production graph** — it discovers every package
carrying a `tsconfig.check.json` (both of them) rather than listing them, so a
third package cannot be silently uncovered — and it **verifies its own coverage**:
it resolves each config with `--showConfig` and refuses to pass if the resolved
program contains no `*.test.ts`. A future edit that re-adds the exclude fails
loudly instead of going green.

It reports the `tsc` path and version it used, because "which compiler ran" is part
of the evidence (G-SEAM-29 and G-SEAM-36 were both stale-build false findings).

### Mutation test — both directions, plus the control the oracle names

`qualification/results/R2-F10F11/mutation-test.mjs` (reproducible; output in
`mutation-test.txt`). Compiler `Version 6.0.3`; the mutation is a **type** error
(TS2322), not a syntax error, so the BUILD config cannot catch it for the wrong
reason.

| Arm | Command | Observed |
|---|---|---|
| 1 clean tree | `pnpm typecheck` | **exit 0** |
| 2 error in a PRODUCTION file (`protocol.ts`) | `pnpm typecheck` | **exit 1**, `src/protocol.ts(335,7): error TS2322` |
| 3 restored byte-exact | `pnpm typecheck` | **exit 0** |
| control: same error in a TEST file | `tsc -p tsconfig.json --noEmit` | **exit 0 — MISSED IT** |
| control: same error in a TEST file | `pnpm typecheck` | **exit 1**, `src/protocol.test.ts(129,7): error TS2322` |

Both restores were byte-exact, proven by hash:
`protocol.ts` → `c38f7ee8bf94bf82227dc4318754735c2305c827bb51dee258e9c0f3a32047bc`,
`protocol.test.ts` → `bab987c217d58e8db309802eecc1df39c8314a3d303b4dade97fbdfcc0ecdb47`.
`git status` shows no tracked modification afterwards.

The control converts *"a green run under `tsconfig.json` alone is NOT PASS"* from a
sentence in a comment into a measured contrast.

Two measurement traps were found and are documented in the script, because each
produced a wrong reading first:

1. **Newline translation on restore.** Python's `write_text` rewrote 332 LF as 332
   CRLF, so the first "restore" was *not* byte-exact (sha `25349859…`). The restore
   now writes bytes taken from `git cat-file blob HEAD:<path>`.
2. **`pnpm` is not an executable on Windows** (shell script + `.cmd`), so
   `execFileSync('pnpm', …)` fails with ENOENT in ~2 ms — which a script could
   mistake for "the gate failed", reporting the mutation as caught for the wrong
   reason. Same class as the recorded `execFileSync`-cannot-run-a-`.CMD` defect.

---

## 3. Every reference updated

| File | Change |
|---|---|
| `package.json` | **new** — root manifest with the `typecheck` script |
| `helpers/typecheck.mjs` | **new** — the official command's implementation |
| `qualification/runners/check-source-plane.mjs` | **new** — the F11 precondition |
| `.gitignore` | ignore root `pnpm-lock.yaml` and root `node_modules/` — otherwise the official command dirties the tree it checks |
| `docs/OPERATIONS.md` | replaced `tsc -p tsconfig.check.json --noEmit` in the test block with the official command; new "Typecheck — the ONE official command" section; new "qualification source plane (F11 / ID-06)" section |
| `docs/DELIVERY.md` | Trap 4 rewritten around `pnpm typecheck` with the arm table; new F11 precondition section in Install |
| `README.md` | quick start now calls `pnpm typecheck`; the "not the check to cite" paragraph rewritten |
| `qualification/runners/v10-obs-driver.mjs` | **comment only** — marks its `tsconfig.json` use as the REBUILD, not the gate |
| `qualification/runners/v10-res01-driver.mjs` | **comment only** — same |
| `qualification/runners/run-t17-identity.mjs` | **comment only** — same |
| `qualification/runners/boot-harness.mjs` | opt-in `DSH_REQUIRE_CLEAN_SOURCE_PLANE=1` precondition before launch |

### Found but deliberately LEFT

- **The three runners still call `tsc -p tsconfig.json`.** That is **correct** for
  them: they REBUILD `lib/`, and `tsconfig.check.json` has `noEmit`, so pointing
  them at it would break the boot they are preparing. They are annotated so no
  reader mistakes a rebuild for the gate. Their diffs are 8 added comment lines and
  **0 changed lines**.
- **`helpers/new-writer.ps1:77`** also builds with `tsconfig.json` — same reason,
  and it is a build step that dies on failure.
- **`packages/dsh-daily-work/tsconfig.eco.json`** and the two evidence-dir configs
  (`M5-lifecycle/tsconfig.m5.json`, `R10-security/tsconfig.attribution.json`) are
  SCOPED probes, not gates. They are named as such in the docs table rather than
  deleted; they exist because concurrent editors' in-flight errors were being
  attributed to the wrong case.
- **Historical evidence files** under `qualification/results/**` cite the old
  command. They are records of what was run at their tree and are **not** rewritten:
  editing an evidence file to change the command it records would be falsifying
  evidence.
- **`docs/decisions/AUDIT-REQUEST-acceptance-results.md`** records the audit's own
  measurement (`tsc -p tsconfig.check.json --noEmit` → exit 0). Left as the audit's
  finding.
- **`docs/GAPS.md`** — not touched (root owns it).

---

## 4. PRODUCT REACHABILITY

Honest answer, and it matters for this slice.

- **F10's official command is reachable by a human operator and by any CI/runbook
  step**: it is a repository-level entry point (`pnpm typecheck`), documented in
  three manuals, and it is what a reader will now cite. It is **not** a
  model-facing tool and is not meant to be — a typecheck gate is a development
  instrument, not a product surface. There is no CI system in this repository
  (`.github/` does not exist), so "every CI reference" means every documented
  reference, and those are updated.
- **F11's precondition is reachable on the boot path**: `bootAndWait` calls
  `assertCleanSourcePlane()` when `DSH_REQUIRE_CLEAN_SOURCE_PLANE=1`, and that was
  exercised — the boot refused before launching, naming the offending entry. The
  default is off by design, and that is a deliberate reachability limit rather than
  an oversight: making it unconditional would change the behaviour of every sibling
  writer's exploratory probe mid-round.
- **Neither change is on the model-facing product path**, and I am not claiming it
  is. They are qualification-plane and development-plane instruments. The V3 exit
  criterion for this slice is "clean source plane; one authoritative compiler gate",
  not "a model can call it".

---

## 5. UNRESOLVED UNKNOWNs

1. **Whether the EOL entry can be cleared without touching the shared index is
   unknown.** `git add --renormalize` is the only mechanism found; it writes the
   index. A fresh checkout with `core.autocrlf=false` is the alternative and was not
   tested, because creating a second checkout of the pinned commit is outside this
   slice and would itself be a change to the qualification environment.
2. **Whether `ID-06`'s oracle should admit an EOL carve-out is a decision for the
   spec's owner, not for the agent that ran the stimulus.** The v1 oracle is frozen;
   this report records the measurement rather than proposing an edit to it.
3. **`data-artifacts/` has a live producer in the source, but it did NOT
   regenerate during this session.** RETRACTED CLAIM, recorded rather than
   deleted: an earlier revision of this file said the directory reappeared after
   the move, on the strength of a `tmp/` mtime of `08:02`. That was a misreading —
   `08:02` **predates** the move (09:34), and `data-artifacts/` is **absent** now.
   The raw observation stands and is unchanged: the directory held exactly one
   content-addressed object (02:02) and an empty `tmp/` (08:02), and it is gone
   because I moved it. What remains true, and is the reason this is still worth
   flagging, is the **source** fact: `defaultArtifactRoot` reads a `root` property
   the mounted `storageDomain` service does not have, so the store falls back to
   the **relative** `data-artifacts` resolved against process cwd (recorded as
   **G-R5-04** in `qualification/results/R5-data/FINDINGS.md` and
   `T8-data/GATES.md`; the same fact is why the V7 boot probe reported
   `storeRootResolved: D:\DSH\src\dsh-src\data-artifacts`). So any tool run with
   the checkout as cwd **will** write an artifact root into it. That is a real
   producer and it is outside my slice; my gate detects the symptom before launch
   and does not remove the cause.
4. **Whether a third package would be covered** is untested — the discovery rule is
   "every `packages/*/tsconfig.check.json`", and there are two. The rule is
   written to extend, but only two packages exist.

## 6. CLAIMS I AM NOT MAKING

- **Not claiming `ID-06` PASSES.** It remains **FAIL**. The tree is not clean: one
  line-ending artifact remains, and the oracle is unconditional.
- **Not claiming the pinned checkout is "unmodified".** Its HEAD matches and no
  tracked *content* was modified, but `git status` is not empty. Those are different
  sentences and only the second is true.
- **Not claiming git cleanliness is part of the deployment identity.** It is an
  environment precondition. The identity is unchanged by this slice, and
  `compatibility.lock.json` was not edited.
- **Not claiming the EOL entry is harmless.** I claim its *blob id equals HEAD's*,
  which is measured. Whether a CRLF checkout is acceptable for a qualification run
  is a judgement about the environment, and I have not made it.
- **Not claiming `pnpm typecheck` proves the product works.** It proves the complete
  production graph, tests included, type-checks. Nothing about runtime behaviour.
- **Not claiming the product is repaired.** Neither F10 nor F11 is a product defect;
  both are qualification's own modelling errors, and this slice redefines the
  instruments rather than changing product behaviour.
- **Not claiming the F11 producer is fixed.** The source-level producer of a
  relative `data-artifacts` root (G-R5-04) is untouched and out of slice; it did not
  fire during this session. The gate catches the symptom; the cause remains.
- **Not claiming `pnpm typecheck` is exercised by CI.** There is no CI in this
  repository. The claim is that every *documented* reference uses it.
- **Not claiming the guard is on by default.** `DSH_REQUIRE_CLEAN_SOURCE_PLANE=1`
  is opt-in, and a run that does not set it gets no precondition guarantee.
- **Not claiming the three annotated runners now cite the official command.** They
  deliberately do not; they rebuild, and that is a different operation.
- **Not claiming `check-source-plane.mjs` covers non-git dirt.** A build output
  directory that is `.gitignore`d is invisible to it by construction (618 such
  entries exist in the checkout). It answers the oracle's question — `git status
  --porcelain` — and nothing wider.
