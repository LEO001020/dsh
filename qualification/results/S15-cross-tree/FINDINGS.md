# S15 — CROSS-TREE HAZARD SWEEP: FULL HIT LIST AND CLASSIFICATION

**Slice:** find and eliminate every remaining cross-tree hazard — code or evidence
that reads or writes a path belonging to a DIFFERENT checkout.

**Tree measured:** `D:\DSH\work\wt-s15` (branch `wt/s15`), commit `fdd8863`.
**Machine:** Windows trusted-local, fifteen writer worktrees live concurrently.
**Command that produced the census:** the walk recorded in §1 (`_rows.json` is the
raw output; 807 occurrences over 1337 candidate files).

---

## 0. THE ONE-SENTENCE FINDING

A path literal that names ONE checkout cannot be correct for a repository that is
checked out in MANY places at once. **32 source-plane files were fixed; 8 live
occurrences remain and are owned elsewhere; 4 files were already correct and are
re-asserted by mechanism.**

---

## 1. THE CENSUS — 807 OCCURRENCES, BY AREA AND KIND

Every occurrence of a `D:\DSH\work\<something>` literal in the tree, classified by
where it lives and whether it is live code or a comment.

| area | files | occurrences | disposition |
|---|---|---|---|
| `qualification/results/**` | 185 | 623 | **HONEST HISTORY** — left untouched |
| `.probe/**` | 50 | 102 | **SCRATCH** — left untouched (see §5b) |
| `qualification/runners/**` | 41 | 41 | **31 fixed**; 2 commentary-only; **8 live remain** (§5c) |
| `docs/**` | 8 | 24 | **PROSE** — must be able to quote a defect's literal |
| `packages/**` | 6 | 12 | 2 already derived; 2 justified; 2 commentary-only |
| root + `helpers` + `profiles` | 3 | 5 | 4 justified (§5d/§5e), 1 provisioning receipt |

**Source-plane files containing a checkout literal: 50. Fixed by this commit: 32.
Not fixed: 18** (11 of them commentary-only or justified, 8 live in the ratchet —
enumerated in §5).

### Classification vocabulary used throughout

- **PINNED-CHECKOUT-LEGIT** — `D:/DSH/src/dsh-src`. The read-only upstream this
  deployment is qualified against. Allowed; never a hazard. (3628 occurrences.)
- **DERIVE** — should be computed from `import.meta.url`/`import.meta.dirname`.
  This is the correct fix for a file that runs.
- **HONEST HISTORY** — a recorded artifact naming the tree it was measured in.
  Rewriting it would destroy the provenance the artifact exists to carry.
- **PLACEHOLDER-VALUE** — a fixture whose oracle is absoluteness, not a directory.
- **PROVISION-TIME** — a value the provisioner rewrites; cannot be derived.

---

## 2. LIVE WRITES — THE `G-SEAM-61` / `G-SEAM-66` CLASS (13 FIXED)

These are the worst hits: an absolute path into ONE checkout, with **no override at
all**, writing into the evidence directory that a verdict then READS.

| file:line (before) | wrote | read back by |
|---|---|---|
| `verify-c2-service.mjs:25` | `M8.5-c2-real-boot/finding.json` | the C2 verdict |
| `verify-tools.mjs:23` | `M8.5-c2-real-boot/tools-host.json` | C2 host-scope evidence |
| `verify-preset-tools.mjs:40` | `M8.5-c2-real-boot/preset-tools.json` | C2 preset evidence |
| `verify-b02.mjs:29` | `M9.17-b02-resolver/b02.json` | B02 verdict |
| `verify-b03.mjs:35` | `M9.18-b03-lifecycle/b03.json` | B03 verdict |
| `verify-data-plane.mjs:58,99` | `M4-data/profile-boot.json` | M4 verdict |
| `verify-e2e-tool.mjs:22` | `M8.5-c2-real-boot/e2e-tool.json` | **`dep-gates.test.ts:188` READS THIS** |
| `verify-guard.mjs:22` | `M9.21-guard-mounted/guard.json` | B04 verdict |
| `verify-ipython-e2e.mjs:31` | `M11-ipython/e2e-tool.json` | M11 verdict |
| `verify-m2-scope.mjs:42` | `M2-scope/boot-probe.json` | M2 verdict |
| `verify-m7-history.mjs:37` | `M7-history/boot-probe.json` | M7 verdict |
| `verify-unwired.mjs:70` | `R3-unwired/profile-boot.json` | F1 verdict |
| `verify-writers-mounted.mjs:36` | `M8-verification/writers-mounted.json` | B0x verdict |

**Why it was invisible.** The finding is a small JSON object that looks the same
from either tree, so the overwrite reads as "the value is what it always was"
rather than "another tree wrote here". `u03-sustained-load.test.ts`'s comment calls
this out for its own case: the artifact is a *nondeterministic* measurement, so the
overwrite reads as "the numbers moved".

**Fix.** Each derives the repo root from its own location, two levels up from
`qualification/runners/`, and keeps an explicit env override
(`C2_OUT`/`TOOLS_OUT`/`PRESET_TOOLS_OUT`/`B02_OUT`/…).

---

## 3. LIVE READS AND DRIVER PATHS (19 MORE FILES FIXED)

| file | what was hardcoded | kind |
|---|---|---|
| `run-t17-identity.mjs:38` | `REPO` → profile src, session root, digests, writes | read + write |
| `v10-obs-driver.mjs:15` | `REPO` → profile src, digests, overlay, writes | read + write |
| `v10-res01-driver.mjs:31` | `REPO` → same | read + write |
| `v7-fs-driver.mjs:27` | `REPO` → `RESULT_DIR`, digests, writes | read + write |
| `v7-fs-probe.mjs:83` | `REPO` → `OUT`, lock + spec reads, workspace writes | read + write |
| `verify-t2-fs.mjs:80` | `REPO` → `RESULT_DIR`, workspace writes + rmSync | read + **destructive** |
| `verify-t2-fs-driver.mjs:19` | `REPO` → `RESULT_DIR` | write |
| `verify-t2-fs-control.mjs:17` | `REPO` → `RESULT_DIR`, `boot.json` read | read + write |
| `verify-a12.mjs:55` | `REPO` → session root, digests | read |
| `verify-t3-shell.mjs:94,272` | `REPO` → `RESULT_DIR`, artifact digests | read + write |
| `run-t3-shell.mjs:29,60,77` | `RESULT_DIR`, digest read, patch argv | read + write |
| `v3-ipython-boot.mjs:19,21` | `OUT`, `PATCH` | write |
| `v3-ipython-surface.mjs:47` | `OUT` default | write |
| `verify-cmp-composition.mjs:34` | `OUT` default | write |
| `verify-t4-preset.mjs:68` | `OUT` default | write |
| `verify-deliverable-surface.mjs:45` | `OUT` default | write |
| `verify-t10-capacity.mjs:53` | `OUT` default | write |
| `v10-obs-plane.mjs:36` | `OUT` default | write |
| `v10-res01-chain.mjs:51` | `OUT` default | write |
| `import-graph.mjs:44` | `pkgRoot` for a source walk | read |
| `t2-probes/fs06b-probe.mts:36` | **`file://` import of the MAIN tree's `src/worktree-isolation.ts`** | **code load** |
| `v7-file-fs-cases.py:18` | `ROOT` for a write-heavy probe | read + write |

### SESSION-CWD HITS — 7 FIXED, AND WHY THEY WERE NOT ALL HAZARDS

`v10-obs-plane.mjs:72,74` · `v10-res01-chain.mjs:103` · `v3-ipython-boot.mjs:28` ·
`v3-ipython-surface.mjs:91` · `verify-cmp-composition.mjs:295` ·
`verify-deliverable-surface.mjs:99` · `verify-t10-capacity.mjs:151` ·
`verify-t4-preset.mjs:299`

The coordinator flagged these as possibly MEANINGFUL — a probe wanting a workspace
that is not the profile directory. **Checked, and the concern is right in general
but does not apply here:** every one of these probes passes `cwd` to
`sessionController.create()`, and what the gate asserts about the session is the
preset/tool surface, not a file under that cwd. The value is a *workspace label*,
not a tree the probe measures. They were changed to `REPO_ROOT` because a
main-tree cwd is still a wrong-by-default value, **not** because they were
corrupting evidence. `verify-t2-fs` and `verify-t3-shell` already used a
`WORKSPACE` temp dir, which is the correct pattern for a probe that really does
need a workspace.

---

## 4. SIBLING-WORKTREE LITERALS — STRICTLY WORSE (11 FIXED, 1 REMAINS)

A `wt-<name>` literal names **another writer's ephemeral branch**. Unlike a
main-tree default, there is no reading under which it is the right target.

**Live writes to a sibling's tree (fixed):**
`r7-cursor-realm-probe.mjs:48` (`OUT`) · `:82` (`probeDir`) ·
`v2-identity-probe.mjs:45` (`OUT`) · `:64` (`SESSION_CWD`) ·
`verify-r4-authorization.mjs:47` (`OUT`) · `:220` (session cwd) ·
`run-v2-identity.mjs:27` (`REPO` → digests + writes).

### THE PATCH-FILE CASE: CROSS-TREE **CODE EXECUTION**

This is the most serious single finding, and it is a *mechanism*, not a guess. A
cordis row's `name:` is a MODULE SPECIFIER. Read in the pinned source:

```
packages/boot/app-boot/src/index.ts:521
  const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
vendor/loader/src/config/tree.ts:122-126
  if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
  else if (name.startsWith('.')) return await import(new URL(name, this.ctx.baseUrl).href)
```

So an absolute `name:` is imported **from exactly that file, whichever tree is
booting**. 29 patch files named a SIBLING worktree this way; a boot from any other
tree would **execute that sibling's probe** while believing it measured its own
composition.

**A relative `name:` is NOT a substitute**, and this is the trap: `ctx.baseUrl` is
the **PROFILE directory** (`packages/boot/app-boot/src/index.ts:939`), not the patch
file and not the repository. `./probe.mjs` would resolve under
`$DSH_HOME/profiles/daily/`, where no such file exists. The pinned checkout's own
tests use `name: ./noop.mjs` (`app-boot/tests/config-dump.spec.ts:36`) against a
fixture tree, which is why the relative form looks supported and is not.

**Fix — `qualification/runners/overlay.mjs`.** A shared helper rewrites the probe
row to the caller's own path and writes the overlay into the caller's own tree.
Applied to 7 overlays; 18 more are now templates with a loud-failure placeholder.

---

## 5. WHAT WAS **NOT** FIXED, AND WHY — STATED PLAINLY

### 5a. `qualification/results/**` — 623 occurrences, LEFT AS HONEST HISTORY
An artifact that records which tree it was measured in is doing its job. Rewriting
it would destroy the provenance it exists to carry. **Not a hazard; the audit trail.**

### 5b. `.probe/**` — 102 occurrences, LEFT AS SCRATCH
Not a deliverable, not loaded by the product. Several files are themselves records
of a past investigation. **It CAN reach a boot** (`.probe/*.patch.yml` name probe
modules), so this is a real residual — but those overlays are one-off measurement
harnesses whose literals are historical, and they are not in my slice.

### 5c. THE 8 OVERLAYS WHOSE ONLY CALLERS ARE IN THE EVIDENCE PLANE

`verify-cmp-composition` · `verify-deliverable-surface` · `verify-ipython-e2e` ·
`verify-t10-capacity` · `verify-t2-fs` · `verify-t3-shell` · `verify-t4-preset`
(main tree) and `verify-r4-authorization` (**sibling `wt-r4`**).

Each is referenced by a driver under `qualification/results/**`, which is recorded
history I must not edit. Fixing them means changing those callers to materialise
the overlay — a change to artifacts this slice does not own. They are recorded in
the gate as a **SHRINK-ONLY RATCHET**, so the set cannot grow silently and a fixed
file must be removed from the map.

### 5d. `profiles/daily-candidate/package.json:5-6` — OWNED BY S1
Names the MAIN tree in its `link:` targets. **Cannot be derived** (pnpm consumes it;
there is no `import.meta`), and `helpers/new-writer.ps1:99` rewrites it with a
**literal string replace**. If either side moves, the replace silently matches
nothing and every writer boots the main tree while believing it booted its own —
this defect class reproduced by a one-character edit, **with no error**. Reported
by the coordinator as S1's; **not edited by me**. Gated by the
`PROVISIONER/PROFILE COUPLING` arm so the two cannot drift apart unnoticed.

### 5e. `helpers/new-writer.ps1:26,99` — JUSTIFIED, WITH A CAVEAT
The provisioner's `-Repo` default. No `import.meta` in PowerShell; the literal is
the point of the file. **The gated fragility is §5d's rewrite, not this default.**

### 5f. FILES I DID **NOT** EXAMINE IN DETAIL
I examined the **50 source-plane files** that contain a checkout literal (all of
them — §1 is a complete census, not a sample). I did **not** read the 185
evidence-plane files or the 50 scratch files line by line; for those I classified
by AREA and disposition rather than by reading each occurrence. **The 623 + 102
occurrences in those two planes are classified, not individually verified.**

### 5g. Files owned by S7/S9/S12 — REPORT-ONLY
Per the coordinator's boundary: `data-r6.test.ts`, `data-plane.test.ts`,
`capacity.test.ts`, `f5-admission.test.ts`, `authorization-path.test.ts`,
`no-src-imports.test.ts`. **Re-confirmed zero hardcoded checkout paths** in all of
them (`D:/DSH/work` and `D:\DSH\work` both grep to 0). Nothing to report.

---

## 6. THE THREE KNOWN-FIXED FILES — RE-VERIFIED BY MECHANISM

| file | round-1 fix | status |
|---|---|---|
| `u03-sustained-load.test.ts:483` | `fileURLToPath(new URL('../../..', import.meta.url))` | **HOLDS** |
| `eco.test.ts:1286` | same, for the ECO-07 profile hash root | **HOLDS** |
| `dep-gates.test.ts:54` | `resolve(import.meta.dirname, '..','..','..')` | **HOLDS** |

`G-SEAM-66`'s real cause was a worktree-RELATIVE path at `dep-gates.test.ts:54`. It
is now correct, and its writes (line453 `typecheck-errors.txt`, line622
`declared-vs-imported.txt`) are rooted in the running tree.

**The same pattern elsewhere (any test computing a path relative to its own file
and then writing):** audited every test file deriving from `import.meta`. **12
files derive AND write**, and all 12 are correct — each writes into either its own
tree (via a derived `REPO_ROOT`) or into a temp dir:

| file | writes to | verdict |
|---|---|---|
| `dep-gates.test.ts` | `REPO_ROOT/qualification/results/…` | **own tree, derived** |
| `upg-gates.test.ts` | `EVIDENCE = join(REPO_ROOT, …)` | **own tree, derived** |
| `u03-sustained-load.test.ts` | `fileURLToPath(new URL('../../..', …))` | **own tree, derived** |
| `eco.test.ts` | reads/hashes its own tree | **own tree, derived** |
| `profile-config.test.ts` | `mkdtempSync(join(import.meta.dirname, '..', …))` | temp dir |
| `data-plane` · `data-r6` · `data11-cursor-realm` | `join(root, …)` where root is a tmpdir | temp dir |
| `durability-advanced` · `security-denial` | tmpdir | temp dir |
| `tool-protocol` · `u01-coding-loop` | `tempDir(...)` / copies into a tmpdir | temp dir |
| `verification-gates` · `verify.test.ts` | `new URL(…, root)` where root is a tmpdir | temp dir |

**No unfixed instance of the G-SEAM-66 shape was found.** The two that write into
the repo itself (`dep-gates`, `upg-gates`) both derive the root, which is the
correct form.

### THE END-TO-END PROOF THAT THE FIX WORKS (not an assertion)

Running `u03-sustained-load.test.ts` in `wt-s15` rewrote
`D:\DSH\work\wt-s15\qualification\results\M9.20-real-tasks\u03-load.json`
(mtime 18:59) while the MAIN tree's copy stayed at **10:10**. Same for
`dep-gates.test.ts`: my tree's `M-DEP-SEC-UPG/typecheck-errors.txt` moved to 18:59,
the main tree's stayed at **07:31**. **A writer in a worktree now writes its own
tree, measured.** Those two artifacts were reverted before committing, since their
content is not this slice's.

---

## 7. THE GATE

`packages/dsh-daily-work/src/cross-tree-paths.test.ts` — **7 arms, 7 pass.**

It refuses exactly ONE shape: a drive-letter path whose first two segments are
`DSH/work`. That is narrower than "any absolute path" **on purpose**, so the four
legitimate classes are excluded **by construction rather than by allowlist**:

1. the pinned checkout `D:/DSH/src/dsh-src`;
2. recorded history `qualification/results/**`;
3. a foreign cwd (`C:/Windows/Temp`) or an interpreter (`…/Python314/python.exe`);
4. provision-time values, which have their own arm.

**The arms:** (1) the blanket scan; (2) allowlist rot — every justified entry must
still exist AND still contain its literal, so it must be removed when fixed;
(3) the three known-fixed files asserted by MECHANISM, so "the literal is gone"
cannot be satisfied by deleting the feature; (4) sibling refs in patch rows;
(5) the shrink-only ratchet; (6) the provisioner/profile coupling; (7) the
negative control.

**Why there is no giant allowlist.** The gate needed 4 justified files and 8
ratcheted overlays — not 900. A gate that needs an allowlist that large is
measuring nothing, so the scope was narrowed until the list was short enough that
every entry is a decision.

### MUTATION TEST — THE GATE WAS SHOWN RED, THEN RESTORED

| injection | result |
|---|---|
| `const S15_MUTANT = 'D:/DSH/work/dsh-native-daily/…'` into `signal.test.ts` | **RED**, naming `signal.test.ts:77 [MAIN_CHECKOUT]` |
| same, changed to `'D:/DSH/work/wt-r3/…'` | **RED**, naming `[SIBLING_CHECKOUT]` |
| backslash spelling `D:\\DSH\\work\\dsh-native-daily` (in-memory control) | **RED** |
| a comment naming the literal (in-memory control) | **NOT red** — commentary is not an offence |
| `fileURLToPath(new URL('../../..', import.meta.url))` (in-memory control) | **NOT red** — the fix must not fire the gate |
| pinned checkout / foreign cwd / interpreter / drive root / `DSH_HOME` | **NOT red** — the four legitimate classes |

`signal.test.ts` was restored and verified **byte-identical** (`git diff` empty).

---

## 8. TEST RESULTS

| command | result |
|---|---|
| `node node_modules/vitest/vitest.mjs run src/cross-tree-paths.test.ts` | **7 passed / 0 failed** |
| `node node_modules/vitest/vitest.mjs run src/dep-gates.test.ts` | **37 passed / 0 failed** |
| `node node_modules/vitest/vitest.mjs run src/u03-sustained-load.test.ts` | **4 passed / 0 failed** |
| `node node_modules/vitest/vitest.mjs run src/eco.test.ts` | **36 passed / 0 failed** |
| `node node_modules/vitest/vitest.mjs run src/no-sandbox-contract.test.ts` | **34 passed / 0 failed** |
| `node helpers/typecheck.mjs` (tests INCLUDED, the official command) | **PASS**, 93 files (39 production + 54 test), exit 0 |
| `node --check` over all 50 `qualification/runners/**/*.mjs\|.mts` | **0 failures** |
| `ast.parse` on `v7-file-fs-cases.py` | **OK** |
| overlay helper: 7 templates + 2 negative controls | **0 failures** |

One file at a time, never the whole suite, per the round-2 discipline.

---

## 9. UNRESOLVED UNKNOWNS

1. **The 8 evidence-plane-owned overlays are unfixed** and each is a live
   cross-tree code-execution path for any boot that uses it from another tree. The
   ratchet stops the set growing; it does not close these.
2. **`.probe/**` overlays (102 occurrences) were not fixed.** They name the main
   tree in `name:` rows, so they are the same code-execution class. Not my slice.
3. **`verify-r4-authorization.patch.yml` names a SIBLING (`wt-r4`)**, which is the
   worst of the 8 — there is no reading under which a sibling is the right target.
   Its only caller is in the evidence plane.
4. **The provisioner rewrite is still a silent no-op if the literal drifts.** Now
   GATED, not fixed. The real fix (make the replace fail loudly) is S1's.
5. **No runtime verification of the 32 fixed runners.** They were fixed and
   syntax-checked; only the overlay helper and the four test files were RUN. The
   drivers boot real hosts and would stress the box, so they were not executed.
6. **Whether any unfixed literal is actually REACHED at runtime** is not
   established for any file. See the claims below.

---

## 10. CLAIMS I AM NOT MAKING

1. **A static scan cannot prove a path is never reached at runtime.** Every hit in
   this document is a *textual* finding. I did not instrument any runner to observe
   which path it actually opened.
2. **"The literal is gone" is not "the behaviour is right."** For the 32 fixed
   runners, I showed the derivation resolves into this worktree (runtime-checked
   for 13 of them) and that the files parse. I did **not** boot them.
3. **The gate is not a proof of correctness.** It proves a NEW literal of one named
   shape has not entered the scanned plane. It does not prove an existing path is
   correct, and it does not see a path assembled from fragments at runtime.
4. **The gate's scope is a choice, not a law.** `qualification/results/**`,
   `.probe/**` and `docs/**` are excluded as history/scratch/prose. If a reviewer
   disagrees with that boundary, the exclusion is the thing to argue with — not a
   claim that those planes are safe.
5. **The 8 ratcheted overlays are not "acceptable".** They are recorded, bounded and
   attributed to their owners. A reader must not read the ratchet as a verdict.
6. **The census is textual and area-based outside the source plane.** The 185
   evidence-plane files and 50 scratch files are classified by area, not read.
7. **I did not verify that a boot with a materialised overlay actually loads the
   probe.** The helper's rewrite is proven against the real templates and its
   failure modes are proven, but no host was booted.
8. **Nothing here proves the product is correct.** This is a path-hygiene slice; it
   says nothing about whether any gate's verdict is true.
