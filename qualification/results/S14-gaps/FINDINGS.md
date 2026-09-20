# S14 — the GAPS ledger made trustworthy

**Slice:** the GAPS ledger is the project's memory; make it trustworthy.
**Worktree/branch:** `D:\DSH\work\wt-s14` / `wt/s14`
**Files owned:** `docs/GAPS.md`, `qualification/results/S14-gaps/**`

---

## 0. The one-line result

108 entries in, 109 out. Six table rows were structurally broken, three
contained literal control bytes that made the file unreadable by ordinary text
tools, four entries carried no verdict at all, two duplicate pairs were
unmarked, one referenced id had no entry, and **nine entries stated a defect
that round 1 had already closed** — each of those would have sent a later writer
to fix something that is not broken. Nothing was deleted.

---

## 1. Before / after, measured

Both files are produced by `audit-gaps-hygiene.py`, which reads `docs/GAPS.md`
and nothing else.

| measurement | before | after |
|---|---|---|
| entries | 108 | **109** (+1 reconstructed `G-FIX-10`) |
| malformed table rows (unescaped `\|` splits a cell) | **6** | **0** |
| literal control bytes | **3** | **0** |
| entries whose Status has no leading verdict | **1** | **0** |
| referenced-but-undefined ids | `G-FIX-10`, `G-WEB-01`, `G-WEB-03` | `G-WEB-01`, `G-WEB-03` (documented aliases) |
| missing ids inside a family | `G-FIX: [10]` | **none** |
| id collisions | none | none |
| leading-verdict histogram | RESOLVED 33, OPEN 49, CONFIRMED 3, VERIFIED 3, FIXED 5, RETRACTED 2, BLOCKED_EXTERNAL 2, REFUTED 1, PARTIAL 1, NO_VERDICT 1, IN_PROGRESS 8 | RESOLVED 43, OPEN 39, **DUPLICATE 2, SUPERSEDED 2**, VERIFIED 3, FIXED 5, BLOCKED_EXTERNAL 3, RETRACTED 2, REFUTED 1, PARTIAL 1, IN_PROGRESS 8 |

`docs/GAPS.md` is now `file`-clean: `Unicode text, UTF-8 text` (before, the Read
tool refused it outright with *"Unsupported or binary text encoding"*).

Artifacts:
- `qualification/results/S14-gaps/hygiene-before.json`
- `qualification/results/S14-gaps/hygiene-after.json`
- `qualification/results/S14-gaps/GAPS.before.md` (the archived pre-edit file)
- `qualification/results/S14-gaps/CLASSIFICATION.md` (the deliverable table)
- `qualification/results/S14-gaps/apply-gaps-hygiene.py` (38 edits, each asserted to match exactly once; refuses to write unless the post-conditions hold)

---

## 2. The classification table

Full table: `qualification/results/S14-gaps/CLASSIFICATION.md` (109 rows, id /
line / subject / verdict). Reproduce with
`python qualification/results/S14-gaps/classify-gaps.py`.

Summary by verdict:

| verdict | n | what it means here |
|---|---|---|
| `OPEN` | 39 | real, not closed; the Note names what would close it |
| `RESOLVED` | 43 | closed by a change in this tree, with a named site or evidence path |
| `FIXED` | 5 | the `G-FIX-*` family, naming the commit |
| `DUPLICATE` | 2 | same defect filed twice; canonical entry named |
| `SUPERSEDED` | 2 | a later entry carries the current measurement |
| `VERIFIED` | 3 | measured positive results kept as evidence, not defects |
| `BLOCKED_EXTERNAL` | 3 | not closable from inside this repo |
| `RETRACTED` | 2 | filed then withdrawn; kept because both were cited elsewhere |
| `REFUTED` | 1 | someone else's claim that did not reproduce |
| `PARTIAL` | 1 | partially addressed; the remaining half is named |
| `IN_PROGRESS` | 8 | `G-TODO-*` only — investigation open, no verdict yet |

---

## 3. Duplicates found

**Both pairs are now marked in place. Neither row was deleted.**

| pair | canonical | why | action |
|---|---|---|---|
| `G-SEAM-64` / `G-R5-04` (the known pair) | `G-R5-04` (`qualification/results/R5-data/FINDINGS.md:359`) | the original identifies where the root actually lives (`storage-json/src/index.ts:30` declares `root` on the **backend**), which the duplicate does not | `G-SEAM-64` marked `DUPLICATE of G-R5-04 (canonical)`, and its one added causal link (`G-SEAM-62`) is preserved |
| **`G-SEAM-11` / `G-SEAM-17`** (new, found by subject comparison) | `G-SEAM-17` | identical subject (`dsh-tool-terminal` mounted by no shipped preset); `G-SEAM-17` is more complete — it names the six tools and states the model's actual route to a PTY (`tool-bash-persistent` / `tool-pwsh-persistent`) | `G-SEAM-11` marked `DUPLICATE of G-SEAM-17 (canonical)`; `G-SEAM-17` marked canonical |

How the second pair was found: pairwise Jaccard + sequence similarity over the
subject cells (`jaccard=0.86, seq=0.91`), not by reading ids. The same run
flagged two near-misses that are **not** duplicates and were left alone:
`G-FIX-08`/`G-FIX-09` (both "a replacement probe reported a phantom", different
probes and different measurements) and `G-SEAM-47`/`G-SEAM-74` (the same
clause before and after its fix — a supersede, not a duplicate).

## 4. Superseded pairs

| pair | successor | why |
|---|---|---|
| `G-SEAM-47` -> `G-SEAM-74` | `G-SEAM-74` | the same `ID-01` graph clause, re-measured after the fix: 223 specifiers with 1 from `src/` became 222 with `sourceRows: []`, 9/9 checks |
| `G-SEAM-49` -> `G-SEAM-62` | `G-SEAM-62` | the same checkout-cleanliness fact, re-measured after the untracked directories were relocated: three dirty entries became one |

## 5. Entries whose claims had become FALSE (the harmful class)

Nine entries said "X is not implemented" or "the gate depends on a weaker
checker" where round 1 had since closed it. Each was checked against the tree at
`fef7612` and re-verdicted with the code site named. **The original text was kept
in every case** — the row now reads `RESOLVED — was: OPEN, ...`, followed by the
original filing.

| id | the now-false claim | what the code actually says | evidence |
|---|---|---|---|
| `G-SEAM-20` | "the shipped profile installs NO launch port" | `WorkService.createRun` calls `installDefaultLaunchPort(input.root)` (`packages/dsh-daily-work/src/host.ts:700`), and `createRun` is reached by `/work start` | `R4-authorization/report-after.json` (33/33, real boot) |
| `G-SEAM-31` | "nothing in the product creates a run" | `src/command-work.ts` registers `/work start [N]` in the HUMAN command registry, mounted at `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml:384-385`; a real boot created a durable run whose `authorizationRef` names the human command | `R4-authorization/report-after.json` |
| `G-SEAM-34` | "nothing in the product ever constructs a `BridgeServer`" | `new BridgeServer(...)` at `packages/dsh-ipython/src/kernel-plugin.ts:493`, before the kernel process | `R5-bridge/composition-tier.json` (`bridgePresentAfterBoot: true`, port 4191) |
| `G-SEAM-33` | "the composed profile's `sandboxPolicy.defaultMode` is `workspace-write`" | the deployment now carries its own row: `mode: danger-full-access` (`profiles/daily-candidate/cordis.patch.yml:539`) | `R1-trusted-local/composition-after.json` (before-file archived) |
| `G-SEAM-41` | "a page cursor is not refused across a different store" | `PageCursor.storeRealmId` + `CursorAuthority.assertRealm` (`src/artifacts.ts:1390,1513`), called from the paging path at `:1755` | `src/data11-cursor-realm.test.ts` |
| `G-SEAM-45` | "concurrent `drain` callers all admit" | the coalescer that synchronized them is gone, replaced by a per-run leader with a generation loop (`src/host.ts:1955-2032`); the invariant lives in one storage-domain update | `f5-admission.test.ts`, arm "WITH THE COALESCER DEFEATED" |
| `G-SEAM-54` | "the bridge route has NO disposition vocabulary" | `BridgeDisposition` with all four members (`packages/dsh-ipython/src/bridge.ts:58-59,263,648-649,712,823`) | `R5-bridge/composition-tier.json` (ledger row disposition `settled`) |
| `G-SEAM-40` | "two of the six gap stages have zero producers" | v2 carries **four** stages; `model-projection` became a `ProjectionManifest` and `transport` an error path (`src/observations.ts:75-137`), schema 1->2 | `R8-taxonomy-split/` |
| `G-SEAM-48` | "the project's own gate depends on the stricter checker" | there is now ONE named command, `pnpm typecheck` -> `helpers/typecheck.mjs` (`package.json:29`), which derives the package set and refuses to pass if the check config sees no test file | `helpers/typecheck.mjs` |

Two more were **partially** stale and were marked rather than closed:
`G-SEAM-19` (already carried its own "PARTIALLY CLOSED" note, left as written)
and `G-SEAM-64` (fixed by R6, folded into its `DUPLICATE` verdict).

## 6. Entries that carried no verdict

Four entries led with a provenance phrase instead of a verdict, which is exactly
the "not actionable" shape the assignment names. Each now leads with a
vocabulary word, and **the original wording is preserved after it**:

| id | was | now |
|---|---|---|
| `G-SEAM-65` | `MEASURED by writer R1 (...)` | `OPEN — measured by writer R1 (...)`; the Note now names both closing options |
| `G-SEAM-07` | `**CONFIRMED BY MEASUREMENT**` | `OPEN (upstream fact, confirmed by measurement)` |
| `G-SEAM-12` | `**CONFIRMED BY MEASUREMENT**` | `OPEN (upstream limitation, confirmed by measurement)` |
| `G-VER-03` | `CONFIRMED — BLOCKED_EXTERNAL ...` | `BLOCKED_EXTERNAL (CONFIRMED) — ...` |

`G-SEAM-60`, `G-SEAM-71` and `G-SEAM-72` led with `**VERIFIED**`, which reads as
a defect marker to a skimming reader. They now carry `VERIFIED (NOT_A_DEFECT)`
or an explicit "the defect it found is FIXED".

## 7. Numbering

- **No collisions.** Every id appears exactly once (`G-SEAM` 1..74, `G-ENV`
  1..6, `G-VER` 1..5, `G-TODO` 1..9, `G-EXT` 1..2, `G-FIX` 1..13).
- **One gap, now filled:** `G-FIX-10` was **referenced twice** (from
  `G-SEAM-22`) and **defined nowhere** — and it is not in this file's git
  history, so the entry was lost, not merely misplaced. A reader following the
  reference found nothing. The row is a **reconstruction**, labelled as one in
  the Status, built from `G-SEAM-22` and from the config it describes
  (`packages/dsh-daily-work/tsconfig.check.json`'s one-entry `paths` map). It
  states explicitly that anything the original said beyond this is `UNKNOWN`.
- `G-SEAM-55..74` are **not** in numeric order within their section (the table
  is in arrival order). That is not a defect and was left alone; the new header
  tells the reader to search by id rather than by position.
- `G-WEB-01` and `G-WEB-03` remain "referenced but undefined" **by design**:
  they are defined in `qualification/results/R6-research/FINDINGS.md`. The
  header now names them as aliases with their filings here (`G-SEAM-52`,
  `G-SEAM-53`), so a reader is no longer left with a dangling id.

## 8. Structural damage repaired

Six rows were split by an unescaped `|` inside a cell, so the cells after it
were parsed as extra columns. Two of them had also pushed text **out of the
table entirely**:

| row | damage | repair |
|---|---|---|
| `G-SEAM-31` | `` `status \| submit \| finish` `` split the row into 8 cells | pipes escaped |
| `G-SEAM-59` | the ACL string `Authenticated Users \| Modify` etc. split it into 9 | pipes escaped |
| `G-SEAM-61` | a `\|` separator inside the Note split it into 7 | escaped |
| `G-SEAM-64` | `{ root?: string } \| undefined` split it into 8 | escaped |
| `G-SEAM-73` | a `grep -E` alternation `(?:settling\|confirmed\|...)` split it into **11** | alternation escaped |
| `G-SEAM-74` | a `\|` separator inside the Note split it into 7 | escaped |
| `G-SEAM-39` | a fenced code block sat **outside** the cell; the row ended mid-sentence and **5 lines** (4 fence lines + 1 prose line) landed outside the table | fence folded into the cell as inline code; the two measurements are preserved verbatim |
| `G-SEAM-62` | the row was **cut mid-path** and 1,521 characters of continuation became orphan prose below the table | rejoined; the corruption is identified in the repair note |

**Three literal control bytes** (one `0x00`, two `0x08`) made the file
unreadable by the Read tool and by any consumer that treats it as text. They came
from the same escape-processing defect already recorded as `G-FIX-11`
(`\b` of `\broker.py` became a backspace; `\r` of `\relocated` became a newline
and `\2` became U+0082; `\u0000` was written as a raw NUL). The header now states
the convention (`\x00` / `\u0000`, never the byte) so it cannot recur silently.

## 9. The boundary with S2

**S2 owns the recovery CLAIM; S14 owns the file's STRUCTURE and HYGIENE.**
`G-SEAM-21` (line 37 before this edit) is the entry about the run-record `epoch`
guard, and S2 may be rewording its claim about what recovery does and does not
promise. **I did not touch that row's text.** I left `G-SEAM-21` exactly as it
stood, including its `OPEN` verdict, because the row's substance is S2's to
state. The only edit anywhere near it is the **new header**, which is above the
first table and touches no entry.

Two adjacent facts I observed but deliberately did not act on, recorded here for
whoever owns them:

1. `G-SEAM-21` says "the run record's `epoch` guard is UNREACHABLE, so the field
   is inert". That is now **literally out of date in a second way**: the field no
   longer exists at all. `packages/dsh-daily-work/src/record.ts:410` states
   "THERE IS NO `epoch` FIELD HERE", `recovery.ts`'s settlement guard was
   deleted, and v2 does not claim the guarantee (see the long note at
   `recovery.ts:189-256` and `qualification/results/R9-recovery-topology/`). The
   same "field is inert" wording still appears in the trailing defect-class table
   at row 3 and in `tool-protocol-guards.ts:61-66`. **All of that is a claim
   about recovery, so it is S2's to correct, not mine.**
2. The trailing defect-class table still lists **row 4**
   (`ctx.dailyHistory.history(caller)` — zero production consumers) and **row 5**
   (`host.ts`'s post-await re-check) as `OPEN`, and they are still open:
   `grep -rn "\.history(" packages/dsh-daily-work/src/*.ts` (non-test) returns
   nothing. Left as written.

## 10. What I verified, and how

Every check below was a read of the tree at `fef7612`. **No suite was run** —
this slice needed none, and the round-2 brief forbids stressing the machine.
"Verified" here means the code site was read and its shape confirmed; it does
**not** mean a runtime measurement was taken by me. Where a claim needed a
runtime fact I cite the round-1 artifact that measured it and say so.

| id | claim checked | method | result |
|---|---|---|---|
| `G-SEAM-20` | launch port installed on the production path | `grep -rn setLaunchPort\|installDefaultLaunchPort` over `packages/**/*.ts` excluding tests; read `host.ts:555-590,694-704` | `installDefaultLaunchPort` called at `host.ts:700` inside `createRun`; no bare `setLaunchPort` production caller (correct — the private installer is the seam) |
| `G-SEAM-31` | `createRun` reachable from the product | `grep -rn createRun`; read `command-work.ts`; `grep -rn command profiles/` | `/work` command registered at `agent.cordis.yml:384-385`; `tools.ts:132` still throws without a run, by design |
| `G-SEAM-34` | `new BridgeServer` has a production call site | `grep -rn "new BridgeServer"` | `kernel-plugin.ts:493` (plus tests/probes) |
| `G-SEAM-33` | the profile sets the mode | `grep -n "danger-full-access" profiles/daily-candidate/cordis.patch.yml`; read the row's rationale at `:461-539` | `mode: danger-full-access` at `:539` |
| `G-SEAM-41` | cursor realm is checked on the paging path | `grep -n assertRealm`; read `artifacts.ts:1745-1762` | `assertRealm` called at `:1755`, before the reference resolves |
| `G-SEAM-45` | the drain coalescer is gone | read `host.ts:1955-2032`; `grep -n "COALESCER" f5-admission.test.ts` | leader + generation loop; the defeated-coalescer arm exists at `f5-admission.test.ts:1121` |
| `G-SEAM-54` | bridge disposition vocabulary | `grep -c disposition bridge.ts native-call.ts` | 39 in `bridge.ts`, 0 in `native-call.ts` (the vocabulary lives in the lease, which is the right owner) |
| `G-SEAM-40` | the stage set is four, not six | read `observations.ts:75-140` | `OBSERVATION_GAP_STAGES` has exactly 4 members; schema version 2 |
| `G-SEAM-48` | one named typecheck command | `grep -n typecheck package.json`; read `helpers/typecheck.mjs` header | `"typecheck": "node helpers/typecheck.mjs"` |
| `G-SEAM-64` | artifact root no longer falls back silently | `grep -n artifactRoot packages/dsh-daily-work/src/data-service.ts cordis.patch.yml` | `dshHomePath('data-artifacts')` at `cordis.patch.yml:281`; fallback recorded at `data-service.ts:216-240` |
| `G-SEAM-49`/`62` | checkout dirt state | `git status --porcelain` + `git rev-parse HEAD` in `D:\DSH\src\dsh-src` | HEAD = `ddefc45f…` (matches the pin); **one** dirty entry (` M packages/deliverables/workspace-changes/src/index.ts`), consistent with `G-SEAM-62` |
| `G-SEAM-61` | hardcoded runner output paths | `grep -rl "D:/DSH/work/dsh-native-daily/qualification/results" qualification/runners/*.mjs \| wc -l` | 22 of 46 `.mjs` runners (the entry says 22 of 38; the denominator has grown with round 1, the numerator is unchanged — the ratio is the part that matters and it improved) |
| `G-SEAM-52` | the selection names another provider | `grep -n searchProvider` in the pinned base bundle | `searchProvider: deepseek-official` at `packages/bundle/base/cordis.patch.yml:461` while the ported row carries `id: daily-search` |
| `G-SEAM-47`/`74` | the source resolution is gone | `grep -rn "attachment-local/src/store"` | no production hit |
| `G-SEAM-55` | the broker path is derived, not hardcoded | `grep -n "import.meta.url\|DEFAULT_BROKER_SCRIPT" kernel-plugin.ts` | `PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))`, `DEFAULT_BROKER_SCRIPT` from it |
| `G-SEAM-67` | the authorization serializer exists | `grep -n serializeAuthorization host.ts` | defined `:838`, used `:973` |
| `G-SEAM-63` | the RECOVERY path installs no port | `grep -n installDefaultLaunchPort host.ts`; read `resume()` at `:1178` | **confirmed still open**: the installer has exactly one caller, `createRun` at `:700`; `resume()` does not install one |
| `G-SEAM-44` | `kernel-lifecycle.ts` is still unreachable | `grep -rn kernel-lifecycle packages/**/src/*.ts` excluding tests; check `package.json` exports | no non-test importer, and the package does not export it — **still open** |
| `G-SEAM-21` | `recovery.ts` reachability | `grep -rn recovery.ts` importers | no non-test importer of `recovery.ts`; `applyWorkerSettlement` no longer exists (deleted) — **left for S2** |
| `G-SEAM-53` | nothing populates `etag` from a search result | `grep -rn provenanceFromFetch\|etag` non-test | the field exists and is optional; the fetch path forwards an input the caller must supply, and no search caller supplies one — **still open** |
| trailing row 4 | `dailyHistory.history(caller)` consumers | `grep -rn "\.history("` non-test | none — **still open** |
| trailing row 5 | post-await re-check in `runDrain` | `grep -n "this.disposed\|signal.aborted" host.ts` | `:2116` is the only in-loop check; the cited `:490-492`/`:1265-1266` line numbers have moved — **still open, line numbers stale** |
| `G-TODO-01,02,04,05,07` | the questions have answers in the tree | `grep -n` over `docs/DSH_SEAMS.md` | all five are answered there (`ctx.terminals` §6.1, `terminalController` §6.2, `storageDomain` §4, `disarm` §"disarm vs pause/complete", waterfall/serial event table) |

**Entries I could NOT verify**, and therefore left untouched: everything whose
claim is a runtime fact I did not re-measure — `G-SEAM-12`, `13`, `16`, `18`,
`19`, `22`, `23`, `24`, `25`, `26`, `27`, `28`, `32`, `35`–`39`, `42`, `43`,
`46`, `50`, `51`, `58`, `59`, `60`, `65`–`74`, all `G-VER-*`, all `G-ENV-*`, and
the `G-TODO-*` rows. For those the verdict as filed stands, and the ones that
needed it already carry a named blocker.

## 11. What S14 did NOT do

- Did not run any test suite. The brief forbids it for this slice and no claim
  here needs one.
- Did not delete a single entry. `GAPS.before.md` is archived so the diff can be
  audited: **109 rows in, 109 rows out** (`108 + the reconstructed G-FIX-10`),
  with zero removals.
- Did not edit the claim in `G-SEAM-21` (line 37) — that is S2's.
- Did not touch `docs/RECOVERY.md`, `docs/INVARIANTS.md`, `profiles/**`,
  `packages/**`, `compatibility.lock.json`, or `qualification/gates.json`.
- Did not verify the round-1 runtime artifacts it cites. They are cited as
  round-1's measurements, under round-1's identity, not as mine.
