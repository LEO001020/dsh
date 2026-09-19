# T5 — the no-sandbox contract guard, and the three failing tests

**Owner:** T5 (re-dispatched). **Branch:** `ipython-native`. **Base HEAD:** `d86e180`.
**Build every measurement below ran against:** `tsc -p tsconfig.json` at
`2026-09-20 07:00:32` (exit 0), after every `src/*.ts` this note touches. Verified
by `stat`: `lib/no-sandbox-contract.js`, `lib/writers-plugin.js` and
`lib/worktree-isolation.js` are all NEWER than their sources. Nothing here was
measured against a stale `lib/`.

**Labels used below:** `[measured]` = a command was run and its output is quoted;
`[read in source]` = the claim comes from reading a file, and is NOT evidence for
a gate on its own.

---

## 1. The three failing tests, and which side was wrong

### 1.1 UPG-01 — `no-sandbox-contract.js` was not compiled

**Symptom.** `every production source must have been compiled: expected
[ 'no-sandbox-contract.js' ] to deeply equal []`.

**Decision: it SHOULD be a production source, and it was made to build.**
The file was not deleted and the test was not touched.

`src/no-sandbox-contract.ts` is 706 lines implementing `ctx.noSandboxContract`, a
read-only deployment self-check. It was left in `src/` by a failed agent with:

- **no `lib/` output** — never compiled, because `lib/` is gitignored and the
  build is a separate step (`packages/*/lib/` in `.gitignore`);
- **no references anywhere** — `grep -rn "noSandboxContract"` over the repo found
  only the file's own declarations: no `exports` entry in `package.json`, no row
  in `cordis.patch.yml`, no test.

**Why the right answer is "make it build" rather than "delete it".** The test's
own oracle is the point: `lib/` must not be a stale SUBSET that happens to satisfy
the `exports` map. A production source with no built counterpart is exactly that
failure. The file is also the artifact this task was asked for — a compiled guard
— so deleting it would have removed the deliverable to make a test green.

**What was done.** `tsc -p tsconfig.json` now emits it (`[measured]`, exit 0), and
`lib/no-sandbox-contract.js` + `.d.ts` exist. **What was deliberately NOT done:**
no `package.json` `exports` entry and no `cordis.patch.yml` row were added. See
§4 (Gap 1) — that is a real remaining hole, stated rather than papered over.

`[measured]` `src/upg-gates.test.ts`: **50 passed / 0 failed**.

### 1.2 The naming case — the honest disclaimer was missing from the plugin

**Symptom.** `expected '/**\r\n * The host-profile entry poin…' to contain
'NOT a security boundary'`.

**Decision: the TEST was right; the SOURCE was wrong.**

The test reads `src/writers-plugin.ts` and requires the literal
`NOT a security boundary`. The file DID carry the claim — but wrapped as markdown
bold across a line break:

```
 * workspace is a `concurrency-isolated worktree`, and it is **NOT a security
 * boundary**.
```

`[measured]` `writers-plugin.ts.includes('NOT a security boundary')` was `false`
(CRLF-normalised read). The failure was a **wrapped literal**, not a missing
claim: the sentence was there, and a `toContain` cannot see through the wrap.

**Why the source was the wrong side, not the test.** The claim is TRUE for this
architecture — under trusted-local every writer child runs as the same OS user
with that user's full authority, so a worktree re-scope contains nothing. A reader
who believes it is a security boundary will skip the checks that actually catch a
hostile writer (the shared-metadata digest, the exact-base refusal, the ref CAS).
`worktree-isolation.ts` already states the same sentence contiguously; the plugin
now does too, and a note was added saying the phrase is kept contiguous ON PURPOSE
because a literal `toContain` is what makes it greppable rather than merely
implied.

`[measured]` the naming case passes. The `FS-06` case in the same file was not
touched (T2 owns it).

### 1.3 VER-09 — the fixture, not the product, was defective

**Symptom.** `expected 'refuse' to be 'accept_for_publication'`.

**Decision: the PRODUCTION path is correct; the TEST fixture was broken.**
This was resolved by measurement, not by argument.

The case assessed `candidate: { cwd: root, baseRevision: base, headRevision: base }`
with **no receipt** and asserted `accept_for_publication`. `[measured]` on the
built artifact (`lib/worktree-isolation.js`), that exact input produces:

```
decision      : refuse
patchApplies  : false
patchBytes    : 0
testsAreReal  : false
reasons:
  - the candidate patch does not apply to the current tree:
    error: No valid patches in input (allow with "--allow-empty")
  - there is no acceptance receipt, so there is no evidence that any test ran
```

`head === base` makes the diff empty, and `[measured]` `git apply --check <empty>`
exits **128** on this host (git 2.55.0.windows.3), so `patchApplies` is `false`.
The assessment therefore refused for **two reasons that have nothing to do with
the ref**, and the assertion failed before the ref logic was ever exercised.

Refusing that input is CORRECT — a candidate with no change and no evidence is
precisely what the integration authority exists to refuse. So the fix was to make
the scenario real, **not** to weaken the assertion:

- a genuine writer worktree, a genuine commit, and a **genuine receipt from a real
  vitest run** (3 tests, `[measured]` 3.6 s) so `accept_for_publication` is earned;
- added `expect(assessment.reasons).toEqual([])` so the acceptance is not a
  near-miss a later edit could turn into an unrelated refusal;
- the ref then advances and the publication is refused — the actual VER-09 claim.

**The sibling case had the same defect and was also repaired.** `ver09c` ("an
unreadable ref is a refusal") used the identical refusing fixture, so its
`accepted: false` was true **whether or not the unreadable-ref branch ran at all**
— an oracle weaker than its scenario. It now supplies the assessment as a literal
`accept_for_publication` with no reasons, making the refusal attributable, and
asserts `reasons` has length 1 and does not contain `the integration assessment
refused`. Same construction the W02 case already uses.

`[measured]` all three VER-09 cases pass.

---

## 2. The contract guard (the deliverable)

**`src/no-sandbox-contract.ts`** (compiled) + **`src/no-sandbox-contract.test.ts`**
(`[measured]` **25 passed / 1 expected fail / 26 total**).

The guard exists because the no-sandbox decision is only real if a **reversion is
loud**. Both reversion directions look healthy from outside:

- **restore a sandbox row** → the deployment silently confines again;
- **delete `sandbox-policy`** → `[measured]` in the decision records: 7 entries
  `pending`, cascading to `shell`/`fs`/`ptcRuntime` never publishing, the preset
  mount failing, and the model's tool face at **`toolCount: 0`** — while the
  process still starts and prints only a warning.

### What the guard catches

Two halves, and the split is the point:

**(a) Decision power, by measurement on synthetic graphs.** Each case feeds a
REVERTED graph and asserts the guard **REFUSES** — asserting `ok: false` is what
makes the detector's power observable, since a guard that always said "fine" would
pass a "the graph is fine" assertion. Covered: a confining fs backend (named, with
its mode), a confining shell, `defaultMode` falling back to `read-only`, an absent
`sandboxPolicy` (tied to the toolCount-0 cascade), a mounted confining PTC
runtime, SSH in either of its two shapes, WSL, a missing IPython service, the
escalation parameters reappearing on any tool, a model-facing `pwsh`, a second
`ipython` parameter, and the `run_code` transport reappearing.

**A control arm is included** — the intended graph must report `ok: true` — because
without it a guard that failed unconditionally would look equally "working".

**(b) Composition, by reading the REAL files.** The decision lives in YAML rows,
not TypeScript, so a live-graph check cannot attribute a reversion. Pinned:
`fs-sandbox`/`pwsh-sandbox` disabled with `fs-local`/`pwsh-local` inserted;
`permission`/`ui-permission` disabled; `approval.policy: never`; `tool-pwsh`
unconditionally `disabled: true` in the daily preset (and NOT via
`process.platform`, which would re-enable it on POSIX); and that the shipped
bundles still **originate** every row the profile patches — if an upstream rename
removes a row, `applyEntryPatches` skips it silently and the deployment reverts
**without the profile file changing at all**.

### The guard was verified to FAIL on a real reversion (4 drills)

Each drill edited a real composition file, ran the guard, and restored:

| drill | reversion applied | result |
|---|---|---|
| 1 | `fs-sandbox` → `disabled: false` | `[measured]` 1 failed |
| 2 | preset `tool-pwsh` → `disabled: false` | `[measured]` 1 failed |
| 3 | **`fs-sandbox` row DELETED** (the silent case) | `[measured]` 1 failed |
| 4 | bundle guard row **DELETED** (the wiring case, §4 Gap 1) | `[measured]` 2 failed |

Every file was then restored and `[measured]` `git status` on
`profiles/daily-candidate/` and `packages/dsh-daily-work/cordis.patch.yml` is
**clean** — byte-identical, no drill residue.

---

## 3. G-SEAM-33 — the deployment default contradicts the stated trust model

**This is the sharpest finding of this task, and it is why the (a)/(b) distinction
below matters.**

`[measured]` on real boots, three independent times
(`T2-fs/boot.json`, `ROOT-verification/sandbox-policy-mode.json`):
`sandboxPolicyDefaultMode: "workspace-write"` — **not** `danger-full-access`.
`[read in source]` `profiles/daily-candidate/cordis.patch.yml` contains **no**
`sandbox-policy` row, so the shipped bundle's
`mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`
(`bundle/base/cordis.patch.yml:218`) stands. The removal plan's step A1 was never
applied.

**Two consequences** (`[read in source]`, verified by the coordinator independently):

1. `sandbox-policy/src/index.ts:46-47` injects a system-prompt line telling the
   model *"Current DSH file policy: workspace-write ... may modify files under the
   session workspace"* — a false statement about its own authority.
2. `ptc-runtime-node/src/index.ts:224` confines unless the mode is EXACTLY
   `danger-full-access`, so PTC is the one path that would still fence.

### (a) vs (b): two different claims, and a reader must not merge them

- **(a) The EXECUTION plane is unconfined — `[measured]`.** `shell.sandboxMode`
  undefined (`PwshLocalExecutor`), `fs.sandboxMode` undefined
  (`LocalFileSystem`), permission plane disabled, approval policy `never`.
- **(b) The POLICY plane still DECLARES `workspace-write` and still confines PTC —
  `[measured]`.** `defaultMode`, `resolve()`, and `ptc-runtime-node:224`.

A reader who saw only (a) would conclude the deployment is fully unconfined. **It
is not.**

**How the guard treats it.** The `defaultMode` assertion is written at **full
strength** (`mode: danger-full-access`) and marked `it.fails` — **not** softened to
`toBe('workspace-write')`, because softening it would make the guard certify the
defect. The mechanism is self-clearing: the moment someone declares the row, the
case turns RED as an *unexpectedly passing* test and forces the marker's removal.
A passing assertion cannot hide behind it. `[measured]` `it.fails` does go red on
an unexpectedly passing body.

---

## 4. Gaps — stated, not papered over

**Gap 1 — CLOSED (was: the guard was compiled but NOT reachable from a profile).**
Originally it had no `package.json` `exports` entry and no `cordis.patch.yml` row,
so nothing would boot it — the *same defect class* the project has recorded four
times (a module with no production caller). It was reported rather than fixed
because both files were outside this task's ownership.

**The coordinator wired it** (`59ad50b`): `exports["./no-sandbox-contract"]` →
`lib/no-sandbox-contract.{d.ts,js}`, and bundle row
`- id: daily-no-sandbox-contract`. `[measured]` by the coordinator on a real boot
of the composed profile from a foreign cwd
(`qualification/results/ROOT-verification/contract-mounted.json`):
`servicePresent true`, `reportOk true`, `checkCount 8`,
`failedChecks ['sandboxPolicy.defaultMode', 'ptcRuntime.sandboxMode']`,
`rowPresent true`.

**The guard independently detects G-SEAM-33 in production.** Those two failing
checks are exactly the sandbox-policy mode and the PTC confinement from §3 — so
the mismatch between the stated trust model and the composed profile is now
detected by a booted production component, not only by an agent's report. That is
a direct consequence of writing the checks at full strength instead of describing
the current state.

**And the closure is now permanent, not a one-off edit.** Three cases were added
so the wiring cannot silently regress: the export must exist AND point at files
that exist; the bundle row must be present and ACTIVE (a `disabled: true` row
would be inert while every other assertion still passed); and the guard must
declare no hard `inject` (the property that made wiring it zero-risk — a pending
row is what produced the measured `toolCount: 0` failure).

`[measured]` reversion drill 4 — deleting the bundle row — makes 2 of those cases
FAIL. The file was restored and `[measured]` `git status` on it is clean.

**The loader id differs from the file id, and that is pinned rather than
rediscovered:** the file says `daily-no-sandbox-contract`, the LOADER says
`include:daily-no-sandbox-contract` (it prefixes inserted rows), and the loaded
row's `name` field is `null`. A probe filtering on the bare id or on `name`
reports a false absence — which is why the test asserts both spellings.

**Gap 2 — `defaultMode` provenance is unobservable.** Config's schema default is
`'read-only'`, and `defaultMode` is a plain `SandboxMode` with no provenance, so
"never configured" and "explicitly configured as `read-only`" are the SAME
observation. The guard reports `modeSource: 'unobservable'` and checks the VALUE
only; it cannot certify the value was declared. Closing this needs an upstream
provenance marker.

**Gap 3 — FS-06b has the VER-09 defect and was NOT touched (T2 owns it).**
`[measured]` on the built artifact, faithfully replicating its fixture (real writer
worktree, committed change, no receipt):

```
decision refuse | patchApplies true | patchBytes 148 | testsAreReal false
  - there is no acceptance receipt, so there is no evidence that any test ran
```

So its `expect(assessment.decision).toBe('accept_for_publication')` fails for a
reason unrelated to the raw-Python gap it means to measure. **Reported, not
edited** — outside this task's file ownership.

**Gap 4 — the guard reads the SURFACE, not callability.** `work` is present in the
catalog but throws `this session has no active run` (G-SEAM-31, cited from the
coordinator rather than rediscovered). The guard asserts tool names and advertised
parameters only, and makes no claim about runtime behaviour.

---

## 5. What is measured vs read

**Measured:** `tsc` exit 0 (build at 07:00:32, and the typecheck at exit 0);
`lib/no-sandbox-contract.js` + `.d.ts` exist; `upg-gates` 50/50; the naming case
passes; VER-09 3/3 passes with a real 3.6 s vitest run; guard 25 pass + 1 expected
fail; the 3 reversion drills each FAIL; `git apply --check <empty>` exits 128;
`defaultMode: "workspace-write"` on real boots; the FS-06b refusal reason.

**Read in source (NOT gate evidence):** the sandbox-policy prompt line, the
`ptc-runtime-node:224` confinement branch, the absence of a `sandbox-policy` row in
the profile, the bundle row origins, and the base bundle's `workspace-write`
default expression.

**Not claimed:** that the deployment is unconfined (see §3), that the guard is
wired into production (Gap 1), or that the full suite is green — the suite baseline
at HEAD is 1153 pass / 9 fail / 46 files, and this task resolved 3 of the 9
(UPG-01, the naming case, VER-09) plus added a new green file.
