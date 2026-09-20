# C6 — the CMP-04 spec contradiction: verified, measured, decided

**Writer:** c6, worktree `D:/DSH/work/wt-c6`, branch `wt/c6`.
**Slice:** resolve the CMP-04 spec contradiction (decision + prepared text, NOT applied).
**Spec edited by me:** none. `qualification/specs/acceptance-spec.trusted-local-v1.json` is
byte-identical to what I received (`885201ed41b0b2d1eb142f3b67058442fb8a43dec16f09af76c9817c8e2dd02e`,
`git status --short qualification/specs/` empty). The coordinator owns that file.

---

## 1. The verified contradiction

Both oracles, quoted verbatim from the live ledger.

**CMP-04** (`status: FAIL`, `mandatory: true`), oracle:

> `toolCountAgentKey` is 28, `ipython` is present, `pwsh` is present, `work` is present,
> `error` is null, and `presetRoots` names the home that was actually booted. A catalog
> measured through a verification overlay that INSERTS the tool row does not establish this case.

**CMP-13** (`status: PASS`, `mandatory: true`), oracle:

> The architecture requires the model-facing shell to leave the daily preset, so `pwsh` (and any
> equivalent shell tool) must be ABSENT from the daily catalog while `ipython` is present. The full
> measured name set is recorded. A catalog that still contains `pwsh` is NOT PASS, and the record
> must state the measured set rather than the intended one.

Both are mandatory, both are read from the **same catalog in the same session**, and CMP-04 requires
`pwsh` present while CMP-13 requires it absent. At most one can hold. **The contradiction is real.**

### The timeline claim checks out exactly

| Fact | Verified value |
|---|---|
| CMP-04's oracle authored | `f6ac93c` = 2026-09-20 **04:59:30** |
| `tool-pwsh` disabled unconditionally | `35c829d` = 2026-09-20 **05:18:50** (19 min later) |
| Preset at `f6ac93c` | `- id: tool-pwsh` / `disabled: !!js process.platform !== 'win32'` → **enabled on win32** |
| Preset at `35c829d` | `- id: tool-pwsh` / `disabled: true` → **unconditionally off** |
| Preset now | `disabled: true`, plus a ~30-line rationale block |

So CMP-04's oracle was **true when written** and CMP-13's was **aspirational when written**; the
commit 19 minutes later inverted which of the two was true. Both cases existed at `f6ac93c`
(confirmed: the spec at that commit contains both CMP-04 and CMP-13, both `NOT_RUN`), so this is not
a case added later against a changed tree — it is one spec authoring pass that emitted two
mutually exclusive oracles.

---

## 2. The CURRENT measured numbers

Booted my provisioned profile from a foreign cwd (`C:/`) with a probe that **inserts no tool row** —
the literal stimulus CMP-04 names. Harness: `qualification/runners/boot-harness.mjs` (binds port 0,
verifies release, asserts the result names the booted home).

`node qualification/results/C6-spec/c6-measure-driver.mjs`

| Quantity | Current value |
|---|---|
| `toolCountAgentKey` | **24** |
| `pwsh` present | **false** (also absent: `bash`, `shell`, `run_code`) |
| `ipython` present | **true** |
| `work` present | **true** |
| `error` | **null** |
| `presetRoots` names the booted home | yes — `D:/DSH/home/c6/profiles/daily/presets/` |
| boot clean | `timedOut false`, `portReleased true`, 0 activation-warning lines |

Full measured name set (24), verbatim:

```
ask_user_question, create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent,
ipython, job_kill, job_list, job_output, list_agents, present, read, read_image, send_message,
skill, todo_write, update_goal, web_fetch, web_search, work, write
```

**Note the number has moved AGAIN since the recorded FAIL.** The FAIL's evidence says 27; the
current tree measures **24**. CMP-13's evidence also cites 27 and is likewise now historical.

### The arithmetic reconciles exactly, with no unexplained row

```
24  (current)                      = measured above
24 + {subagent, subagent_fork, workflow}  (d8b95cb, 20:50:47) = 27   <- the V2-era count
27 + {pwsh}                        (35c829d, 05:18:50)        = 28   <- the count CMP-04 pins
```

`d8b95cb` ("P0.7: disable the four model-facing child-creation rows in daily-standard") disabled
`tool-subagent`, `tool-subagent-fork`, `workflow-ptc` and `tool-workflow`. Verified by
set-difference between the recorded name sets: `V2(27) − current(24) = {subagent, subagent_fork,
workflow}` and `M12(28) − V2(27) = {pwsh}`. Both deltas are pure removals; no name was added.

Every one of the 27-valued measurements on record (`T4-preset/boot-after.json`,
`V2-composition/boot1-*`, `S1-single-mode/*`, `S4-v2-rejudge/runs/id01/boot.json`,
`T17-identity/*`, …) predates `d8b95cb`, which is why they read 27 and the current tree reads 24.

---

## 3. Catalog, or how the count is taken? — **the CATALOG. The artifact explanation is false.**

This was the outcome worth testing rather than assuming, so I tested it three independent ways.

**(a) All eight 28-valued measurements carrying a name set include `pwsh`; none reaches 28 without it.**
A full recursive sweep of every `toolCountAgentKey` on record:

| count | pwsh present | source |
|---|---|---|
| 28 | **true** | `M11-ipython/e2e-tool.json`, `M12-deliverable-surface/surface.json`, `surface-ROOT.json`, `R9-delivery/surface-r9-{verified-fresh-install,user-root-workaround}.json`, `T16-docs/surface-t16.json`, `T4-preset/boot-before.json`, `verify-before.json` (8 of 8) |
| 27 | false | `T4-preset/boot-after.json`, `V2-composition/boot1-*`, `S1-single-mode/*`, `P6-surface/catalog-before.json`, `V3-ipython/IPY-09-tool-surface.json`, … |
| 27 | true | `M8.5-c2-real-boot/e2e-tool.json` (a *different* catalog: shell present **and** one row absent elsewhere) |

`ANY count==28 WITH pwsh ABSENT? **False**` — computed over every recorded JSON in the tree. The 28
and "pwsh present" are not two facts that happen to co-occur; **28 is precisely the name set with
`pwsh` in it**. The pin encoded a composition fact.

**(b) No other scope key or cwd reproduces the oracle.** Measured in one boot: the agent-context key
(the known-wrong key, G-FIX-06) = **0**; the unscoped/global view = **0**; the agent key = 24. Two
session cwds — a foreign directory and the repository root — both = **24**. So the catalog is not
cwd-sensitive and no alternative key yields 28.

**(c) The decisive control already exists and is falsifying.** `S4-v2-rejudge/runs/cmp-pwsh-control`
re-enabled `tool-pwsh` and changed **nothing else**: the count moved 27 → 28 and the name set gained
**exactly `pwsh`**, with exactly one check red. That is a one-row, one-tool, one-count causal chain.

**(d) No preset in this deployment reaches 28.** `includeShippedRoot: false`, so the shipped presets
are not even offered; the only installed preset is `daily-standard`, and the pwsh row in it is
`disabled: true`. There is no "different measurement" in this deployment that satisfies CMP-04.

**Conclusion: the contradiction is about the catalog itself.** CMP-04's oracle is unsatisfiable on
this deployment by any measurement, because the row it names is unconditionally disabled. There is
no wording fix that rescues it, and I will not manufacture one.

---

## 4. Decision

**Recommended: accept as a permanent recorded contradiction, and update CMP-04's NOTE to record the
re-verification and to point at the resolution that has already been built.** Do not touch the
oracle; do not change any status.

My reasoning, in the order it matters:

1. **The forbidden move is not needed and is refused.** Flipping CMP-04 to PASS — or editing its
   oracle to 24/absent — is the one move that would make a gate green by erasing a defect record.
   The spec forbids it twice ("no PASS by editing an oracle after the fact"; "a case may only be
   marked PASS when that file establishes THIS oracle"). CMP-04 stays **FAIL**, and the FAIL is
   *correct under its own oracle*: the catalog genuinely does not match it. The defect is in the
   oracle, and the note says so.

2. **The "supersede under a new identity" option has ALREADY BEEN EXERCISED — so it is no longer a
   cost to weigh, it is a fact to record.** This is the finding that changes the decision. The
   deployment identity is now `533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb`
   (recomputed by me from `compatibility.lock.json`'s declared algorithm — exact match). The lock
   records that every verdict bound to `0a0996f3…` is **STALE** as evidence for the current identity
   and must be re-measured — including all 109 filed cases of this spec. The large cost the note
   described as the price of superseding **has already been paid**.

3. **The corrected revision exists, is root-owned, and is already declared.** Decision **D1** in
   `docs/decisions/V3-v2-oracle-resolutions.md` ("CMP-04 vs CMP-13: the spec contradicts itself")
   chose exactly this: v2 states the current architecture (`ipython` present, `work` present, `pwsh`
   absent, `error` null, **count measured into evidence rather than pinned**), CMP-13 unchanged, v1
   frozen with both oracles and both verdicts intact. It is implemented in
   `qualification/specs/acceptance-spec.trusted-local-v2.definition.json` (contract
   `trusted-local-v2`, 110 cases), and `compatibility.expected.json → acceptance_definition` now
   declares that contract. The provenance file records CMP-04 as `treatment: "rewritten"`,
   `oracle_changed: true`, `authority: "D1"`, `dropped_assertions: ["toolCountAgentKey is 28",
   "pwsh is present"]`, with `why_not_a_loss` naming where the count still lives. **The decision I was
   asked to reach is not an open question — it was decided by the root agent and built. My slice's
   value is to confirm it, re-measure it, and falsify the alternative.**

4. **Why "permanent recorded contradiction" is the right frame rather than a defeat.** Neither case
   is *wrong*: CMP-04 is a true statement about the composition as authored, CMP-13 is a true
   statement about the architecture that superseded it, and the frozen v1 spec is the artifact that
   preserves the divergence. v1's job is history, not the current verdict. Deleting the contradiction
   would destroy the evidence that the spec and the deployment diverged — which is exactly the
   failure mode this project's rules exist to prevent.

5. **A note-only edit is safe, and I verified the mechanism rather than assuming it.** The pinned
   identity input is the digest of the **frozen as-authored snapshot**
   (`qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json`, pinned as
   `trusted_local_acceptance_spec_sha256`), **not** of the live ledger. `helpers/doctor.py` checks the
   live ledger only for **case-id shape**. So correcting a `note` does not move the identity; editing
   an **oracle** would erase the record, and that is what stays forbidden. The identity-input set
   contains no reference to the live ledger (verified directly).

**Rejected alternative, for the record:** superseding v1 *again* under yet another identity. It would
invalidate the 109 filed verdicts a second time to fix a note that does not need fixing, while the
corrected contract already exists and is already declared. It buys nothing.

**Cost of my recommendation:** one note field. No status change, no oracle change, no evidence change,
no identity move, no re-measurement. **Residual cost:** CMP-04 remains FAIL in v1 forever, so any
reader who sums v1's statuses must read the note. That is the intended, honest state.

---

## 5. The prepared patch (NOT applied)

`qualification/results/C6-spec/PATCH-cmp04-note.json` — machine-applicable payload with pre-images,
post-images, digests, and the exact old-note literal plus its occurrence count (proved to be exactly
**1** in the raw bytes, so it applies unambiguously).

- **CMP-04:** replace `note` only. `status` **FAIL → FAIL** (unchanged).
- **CMP-13:** add `note` (the key is currently absent). `status` **PASS → PASS** (unchanged). Optional
  — CMP-13 needs no correction to be correct; this only cross-references the resolution and records
  that its cited 27-name set is historical.

The replacement text, in full, is in the payload. Summary of what CMP-04's new note says:
the FAIL is correct under this oracle; the 19-minute ordering accident is confirmed from git; the
re-verified current numbers are 24 / `pwsh` absent / `ipython`+`work` present / `error` null; the
arithmetic `24 + 3 rows = 27, + pwsh = 28`; the measurement-artifact explanation was tested and is
false; the resolution is D1 and is already implemented as the v2 definition; the cost of superseding
has already been paid at identity `533c8cb0…`; and the oracle is deliberately **not** edited.

### Dry-run proof

Applied to a scratch copy (`qualification/results/C6-spec/dryrun/`), never to the spec:

```
cases that differ (must be exactly CMP-04 and CMP-13): ['CMP-04', 'CMP-13']
ALL statuses equal: True
ALL oracles equal: True
ALL evidence equal: True
ALL requirements/stimuli equal: True
family/count fields equal: True
```

Exactly two cases differ, and only in `note`. Real spec digest re-checked after: unchanged.

---

## 6. Artifacts (all under `qualification/results/C6-spec/`)

| Path | What it is |
|---|---|
| `c6-verdict.json` | the measurement: boot coordinates, digests, result, both cwd arms |
| `c6-surface.json` | the probe's raw finding |
| `c6-measure-driver.mjs` | the driver (boots, reads, records — judges nothing) |
| `c6-surface-probe.mjs` | the probe (adds no tool row; records 3 scope keys + 2 cwds) |
| `c6-transcript.txt` | boot stdout/stderr |
| `PATCH-cmp04-note.json` | **the deliverable patch** |
| `make-patch.py` | generates the payload; asserts the old-note literal is unique |
| `dryrun/DRYRUN-NOT-A-SPEC-spec-copy-after-patch.json` | dry-run output, deliberately renamed so no tool can mistake it for a spec |

---

## 7. What I could not establish / limits of this report

- **I did not re-measure at the identity the coordinator now owns.** My boot ran at whatever identity
  this worktree currently resolves; my job was the CMP-04 question, not identity re-derivation. If the
  coordinator has since changed the preset or profile digests, the count 24 could move again — but the
  *contradiction* does not depend on the number, only on `pwsh` being absent while CMP-04 requires it
  present, and that is enforced by an unconditional `disabled: true`.
- **I did not run the acceptance suite** (constraint: no heavy CPU). The 24 was measured by one real
  boot; it agrees with the arithmetic reconstruction, and the `P6-surface/catalog-after.json` arm on
  record independently reads 24.
- **I did not verify that v2 is formally "adopted" by whatever process the coordinator uses** — only
  that it is declared in `compatibility.expected.json`, built as a 110-case definition, and has a
  provenance decision (D1) authorising the CMP-04 rewrite. Whether adoption is complete is the
  coordinator's call.
- **One row in the record remains unexplained by me:** `M8.5-c2-real-boot/e2e-tool.json` reads
  `count 27` **with `pwsh` present**. That is a different catalog (an older composition missing one
  other row), not a counterexample to the 28 ⇒ pwsh-present rule. I flag it rather than smooth it
  over, since it is the only recorded arm where 27 and pwsh coexist.
- **CMP-13's own evidence is now historical** (it cites 27). Its oracle still holds — `pwsh` absent,
  `ipython` present — so its PASS is sound, but its recorded name set should be read as a
  point-in-time measurement. That is why I prepared the optional CMP-13 note.
