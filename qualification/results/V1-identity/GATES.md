# V1 — IDENTITY family (ID-01..ID-06): measured results

**Slice:** `qualification/results/V1-identity/`
**Deployment identity under test:** `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461`
**Spec:** `qualification/specs/acceptance-spec.trusted-local-v1.json`
**Pinned checkout:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
**Working repo:** `D:\DSH\work\dsh-native-daily` @ `c3b9dba` (branch `ipython-native`)

Every claim below is labelled `[measured]` (a command was run and its output is on disk)
or `[read in source]` (the text was read, not executed). Only the first is evidence.

---

## 0. Gate table

| Case | What it asserts | Exact command | Measured result | Verdict | Build it ran against |
|---|---|---|---|---|---|
| **ID-01** | Boot the built launcher; the first tool call succeeds AND every `@deepseek-ai/*` specifier resolves under `packages\*\lib\`; launcher sha256 = `artifact_sha256` | `node qualification/results/V1-identity/id01-driver.mjs` | 22/23 checks pass. **724** resolution lines, **223** distinct specifiers, **221** from BUILT, **1** from SOURCE. Launcher sha256 `69c49c87…` = pinned. First call `read` returned the file's own text. **The one SOURCE resolution is a real oracle violation.** | **FAIL** | Rebuilt immediately before the boot: `dsh-daily-work` exit 0 (1963 ms), `dsh-ipython` exit 0 (984 ms); `lib` newer than `src` for both (measured) |
| **ID-02** | Identity recomputes from its inputs, and a one-byte change produces a different digest | `python qualification/results/V1-identity/rederive-identity.py` | Recomputed = recorded = `0a0996f3…` (**MATCH**). Re-derived from disk, all 5 file-named inputs match (**MATCH**, `stale = none`). One byte of `host_profile_digest` flipped → identity changes | **PASS** | n/a (T0, arithmetic over files) |
| **ID-03** | Zero old case ids carry a status other than NOT_RUN with no local evidence; zero evidence entries carried across | `python qualification/results/V1-identity/id03-no-inheritance.py` | **38** ids shared with the old spec, **0** shared with `gates.json`. Clause B (operative): **0** inherited verdicts, **0** NOT_RUN-with-evidence. **0** of 36 old evidence paths reappear. **0** entries under a foreign identity | **PASS** | n/a (T0) |
| **ID-04** | The spec digest is pinned as an identity input; changing one character makes both the stored pin and the re-derived identity detect it | `python qualification/results/V1-identity/rederive-identity.py` | Before: pin matches file `True`, derived identity matches `True`. During (1 char changed): both `False`. Both detections `True`. Restore byte-exact `True` | **PASS** | n/a (T0) |
| **ID-05** | Clean tree exits 0 under `tsconfig.check.json`, an injected type error makes it FAIL, no `any`/`as never`/suppression, no private deep import | `node …/tsc -p tsconfig.check.json`; `python …/id05-mutation.py`; `python …/id05-control-arm.py`; `python …/id05-escape-hatch-scan.py` | Clean: `dsh-daily-work` exit 0, `dsh-ipython` exit 0. Mutation: check config exit 2 at the injected line; **control arm: `tsconfig.json` exit 0 — it MISSED the error**. Escape-hatch scan: `as any` 0 real, `@ts-ignore` 0, but **475 `as never`** (469 in test files, 6 in one production file) | **FAIL** | tsc 6.0.3 from the pinned checkout; source tree digest pinned before/after (identical) |
| **ID-06** | `git status --porcelain` is empty and HEAD = `ddefc45fbc7f8e46dd73185e68295696d1297887` | `git rev-parse HEAD`; `git status --porcelain` in `D:\DSH\src\dsh-src` | HEAD **MATCH**. Tree **NOT CLEAN**: ` M packages/deliverables/workspace-changes/src/index.ts`, `?? DSHhomem914/`, `?? data-artifacts/` | **FAIL** | n/a (T0, git state) |

**4 PASS / 2 FAIL.** No case is BLOCKED_EXTERNAL; none of the six needs a live provider.

---

## 1. ID-01 — the built launcher, the real module graph, the first tool call

**The instrument, and why it is stronger than what existed.**
T17 measured module identity by testing `instanceof` against **six hand-listed**
packages. That is a good instrument but a narrow one: it can only speak about
packages somebody thought to list, and its silence about package seven is
indistinguishable from package seven being fine. The oracle here is broader —
"**every** `@deepseek-ai/*` specifier resolves under `packages\*\lib\`" — so this
run records the resolution of every such specifier as the host actually performs
it, via `module.registerHooks()` injected with `NODE_OPTIONS=--import`. The
recorder observes and does not substitute (`shortCircuit: false`), so the boot is
byte-for-byte the boot it would have been without it. `[measured]`

**The graph.** `[measured]` — `runs/id01/graph.jsonl`, 724 lines:

| Question | Value |
|---|---|
| resolution lines | 724 |
| distinct `@deepseek-ai/*` specifiers | 223 |
| resolved from BUILT (`lib/*.js`) | 221 |
| **resolved from SOURCE (`.ts`)** | **1** |
| unclassified | 1 (`apps/web/package.json`, a manifest read) |
| under `packages\*\lib\` | 213 |
| under `vendor\*\lib\` | 7 (cordis, group, include, loader, timer, cosmokit, schemastery) |
| under `node_modules\.pnpm\…\lib\` | 1 (`@deepseek-ai/libreoffice-kit`) |
| outside the pinned checkout | 0 |
| a specifier resolving to two different files | 0 |

**The launcher.** `[measured]` sha256 of `D:\DSH\src\dsh-src\apps\cli\lib\bin.js`
= `69c49c871735dc7ee81ec51f266bbec129f075fd5066e046374f4b13ab02a705`, equal to
`deployment.inputs.artifact_sha256`; the probe's own `process.argv[1]` realpath
equals `deployment.inputs.launcher_realpath`. The success is not `--help`: a real
Session was created, a real turn ran through the real AgentLoop, and the first
tool call named `read` returned `<content>…ID01_FIRST_TOOL_CALL_ROUND_TRIP…</content>`
with `toolResultIsError: false`, `turnEndReason: "completed"`.

**The finding: one `.ts` file is loaded into the product's runtime graph.**

```
specifier  = @deepseek-ai/dsh-attachment-local/src/store.ts
url        = file:///D:/DSH/src/dsh-src/packages/attachment/attachment-local/src/store.ts
parentURL  = file:///D:/DSH/work/dsh-native-daily/packages/dsh-daily-work/lib/artifacts.js
```

`[measured]` and `[read in source]`:

- The importing file is `lib/artifacts.js` — the **BUILT** artifact, not a test
  and not `src/`. `packages/dsh-daily-work/src/artifacts.ts:74` contains the
  import; `lib/artifacts.js:73` contains the same import after the build. So this
  is the path the **product** takes. Node 24 loads the `.ts` by native type
  stripping, so it *works* — which is precisely why it went unnoticed.
- The package's declared exports are `{".": "./lib/index.js", "./src/*": "./src/*",
  "./package.json": "./package.json"}`. There is no public export for
  `publishImmutableObjectStream`: it is declared inside `lib/index.js` (bundled)
  but **not exported**. That is why the consumer reached into `src/`.
- **A built path exists**: `lib/types/store.js` declares the same function. The
  package simply does not export it.
- **Two module instances now exist.** `lib/index.js` inlines its own copy of
  `store.js`, so the host holds two copies of the module-scope state
  `const durableHomes = new Set<string>()` (`src/store.ts:23`,
  `lib/types/store.js:10`, inlined at `lib/index.js:276`). Each copy keeps its
  own set, so `ensureDurableHome` re-proves durability in the copy the other
  cannot see. **Measured consequence: duplicated work and split module state.**
- **The two copies are the SAME REVISION** — `[measured]` by erasing types with
  the TypeScript compiler itself (`id01-revision-compare.py`): the transpiled body
  of `publishImmutableObjectStream` from `src/store.ts` is character-for-character
  identical to the one in `lib/types/store.js`. So this is **not** a
  divergent-behaviour defect. Stated precisely rather than inflated.

**Oracle verdict.** The oracle requires every `@deepseek-ai/*` specifier to resolve
under `packages\*\lib\`. One does not. **FAIL**, and the failure is a real,
product-path finding rather than a measurement artifact.

**Two defects in my own instrument, found and fixed during this run** — recorded
because each produced a confident wrong answer first:

1. The stale-build check scanned `src` for `*.js` and found none, so
   `newestSrcMtime` was `null` and it reported a stale build that did not exist.
   Source files are `.ts`; the extension is now passed in per directory.
2. `classifyUrl` fell back to a `/\\src\\/` substring test, and the pinned
   checkout lives at `D:\DSH\src\dsh-src` — so **every** path inside it contains a
   `src` segment. It flagged `apps/web/package.json` as a SOURCE resolution. This
   is the exact mistake T17 documented for a previous agent. The fallback is
   removed: SOURCE means the file ends in `.ts`, BUILT means a `.js/.mjs/.cjs`
   under a `lib/` directory, and anything else is reported as OTHER. A third
   version also required a *flat* `lib/<file>.js`, which misclassified the eight
   real subpath exports under `lib/types/`.

**Traps observed.** The home installs the extension packages through a `link:`
(`[measured]`: the installed `dsh-daily-work` resolves to
`D:/DSH/work/dsh-native-daily/packages/dsh-daily-work`), so this boot executed the
built `lib/`; both packages were rebuilt immediately before the boot that matters
and the `lib`-newer-than-`src` comparison is recorded in the artifact. The probe
and the graph recorder both write to paths this driver owns, and
`readResult()` asserted the probe's `presetRoots` names the home that was booted
(`D:/DSH/home/v1-identity`). One host was booted, on a harness-bound free port
(14057), and the port released after the kill (`portReleased: true`).

---

## 2. ID-02 — the identity recomputes, and is sensitive to one byte

`[measured]` — `ID-02-ID-04-identity-rederivation.txt`:

- **Stored-input identity:** recomputed = recorded = `0a0996f3…` → **MATCH**.
- **Disk-derived identity:** all five file-named inputs re-hashed from disk and
  the digest recomputed over *those* values → `0a0996f3…`, **MATCH**, `stale = none`.

The second half matters and is not a duplicate of the first. `verify-identity.py`
recomputes over the `inputs` **object as stored in the lock**; that proves the lock
was not edited, not that the inputs are right. T17 measured exactly this failure:
`host_profile_digest` recomputed to a MATCH while pinning a revision of
`profiles/daily-candidate/cordis.patch.yml` that no longer existed on disk. A
digest over a stale value is a well-formed number that describes nothing. So both
halves are reported separately and the disk-derived one is the stronger claim.

- **One-byte change:** flipping the first character of `host_profile_digest`
  (`5b8b…` → `0b8b…`) produces a different identity. `[measured]`

**A defect in my own map, fixed.** The first version pointed
`dependency_lock_sha256` at `pnpm-lock.yaml` in this repo, which does not exist —
the dependency lock lives in the **pinned checkout**. It reported a false `STALE`
row. The pin was correct all along. `[measured]`

---

## 3. ID-03 — no verdict migrates from the old specs

`[measured]` — `ID-03-no-inheritance.txt`. Three comparisons plus an identity check:

| Comparison | Result |
|---|---|
| by **id** — shared with the old 112-case spec | 38 ids (CAP-01..08, IPY-01..08, REC-01..08, RES-01..06, VER-01..08) |
| by **id** — shared with the old 104-case `gates.json` | **0** |
| by **evidence path** — old paths reappearing in the new file | **0** of 36 |
| by **identity** — evidence filed under a non-current identity | **0** |

**Clause A vs Clause B, and why they must not be collapsed.** The oracle's first
clause reads literally: "Zero old case ids appear in this file with any status
other than NOT_RUN." Enforced literally that would make **38 of this spec's own
cases unpassable**, including `VER-01`, whose oracle *requires* a zero-test run to
be measured. The spec cannot mean that: its own `reading_notes` says a case "may
only be marked PASS when that file establishes THIS oracle, at THIS deployment
identity", and its `no_inheritance_rule` says a PASS is valid only with "its own
evidence file, recorded under THIS identity". **Clause B is the operative test**,
and it is the clause that catches inheritance: a carried verdict has no local
evidence, or evidence bound to the wrong identity.

Both are measured and reported. Clause A's raw count is a fact (16 shared ids were
not NOT_RUN at measurement time, each with its own local evidence). Clause B is
the decision, and it passes: **0 inherited verdicts, 0 NOT_RUN-with-evidence**.
Collapsing them either way would be wrong — silently dropping A hides that shared
ids do carry statuses, and enforcing A would force a reader to weaken an oracle later.

**A false finding in my own check, removed.** The "by requirement name" comparison
originally flagged 30 "undocumented re-issues" — because the old spec's
`requirement` fields are **Chinese** (`硬30并发`, `零测试`) and the new spec's are
**English**, so every shared id differs as a string. The comparison was measuring
the language, not the semantics. What *can* be decided mechanically is whether the
spec **documents** a re-issued numbering: only the `VER` family carries a
`numbering_warning`. The finding a reader actually needs is therefore: **CAP, IPY,
REC and RES share ids with the old spec without any statement that their numbering
was carried over unchanged** — so a reader comparing those ids across the two files
must not assume it was. That is recorded as a caveat, not a PASS.

---

## 4. ID-04 — the spec digest is pinned, and the pin detects an edit

`[measured]` — mutation applied to the file the pin **names**, restored in a
`finally`, restore asserted by sha256:

| | stored pin matches file | re-derived identity matches recorded |
|---|---|---|
| before (1 char changed) | `True` | `True` |
| during | `False` | `False` |
| after restore (byte-exact `True`) | `True` | `True` |

**Both detections are `True`.** A reader can see the pin go stale and the identity
move without trusting prose.

### The structural fact this case turns on

**The pin names a FROZEN as-authored snapshot, not the live spec file.** This is
not a detail; it is the difference between the pin working and the pin being a
permanent false alarm.

`trusted_local_acceptance_spec_sha256` = `e5b6a1d2…` names
`qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json`.
The live spec under `qualification/specs/` is **also the evidence ledger**: every
verdict filed against it changes its bytes. `[measured]` the live file moved
`e5b6a1d2` → `341464bc` → `c00a6345` → `97c77075` as sibling families filed
evidence, while the pin stayed at `e5b6a1d2`. Comparing the pin to the live file
therefore reports "stale pin" for the spec doing exactly its job — which is what
the first version of my instrument did, and what `verify-identity.py` was
corrected for at commit `17d1313`.

What must hold instead is the property the spec's own rules demand — **no oracle
was edited after the fact**. Measured, frozen vs live:

| | |
|---|---|
| case ids identical | `True` |
| frozen statuses | `{NOT_RUN: 109}` |
| live statuses (at measurement) | `{FAIL: 6, NOT_RUN: 64, PASS: 39}` |
| **ORACLES edited** | **NONE** |
| **STIMULI edited** | **NONE** |
| **REQUIREMENTS edited** | **NONE** |

So the live ledger differs from the pinned artifact **only** in `status`,
`evidence` and `note` fields — the fields filing a verdict is supposed to change.
**No oracle, stimulus or requirement was touched.** That is the check that makes
every PASS in this spec answer the oracle that was authored rather than a later,
easier one.

---

## 5. ID-05 — the strict check config, and the escape hatches

**Both arms of the oracle, plus the control arm the oracle names.** `[measured]`

| Arm | Config | Injected error present? | Exit | Meaning |
|---|---|---|---|---|
| clean, `dsh-daily-work` | `tsconfig.check.json` | no | **0** | clean tree compiles |
| clean, `dsh-ipython` | `tsconfig.check.json` | no | **0** | clean tree compiles |
| mutation | `tsconfig.check.json` | yes | **2** | `src/dep-gates.test.ts(1313,7): error TS2322` |
| **control** | `tsconfig.json` | **yes** | **0** | **it MISSED the error** |

The control arm is the oracle's own last sentence — "A green run under
`tsconfig.json` alone is NOT PASS, because that config excludes the test files" —
turned into a measurement. Both configs compiled the **same** injected error inside
**one** mutation window. `tsconfig.json` excludes `src/**/*.test.ts` and exits 0;
`tsconfig.check.json` excludes nothing and catches it at the exact injected line.
That contrast is what makes the check config load-bearing rather than decorative.

The mutation is a **type** error, not a syntax error, deliberately:
`vitest.config.ts` runs `pool: 'forks'` with no type-checking step, so a type error
cannot break a concurrent sibling's test run. Restore was byte-exact in every arm.
The source tree digest was pinned before and after the clean compile and was
**identical**, so the tree did not move under the measurement.

### The escape hatches — this is what makes ID-05 FAIL

`[measured]` — `ID-05-escape-hatch-scan.txt`, comments stripped before counting so
that a comment *explaining* a pattern is not reported as one:

| Construct | Count | Reading |
|---|---|---|
| `as any` | **0** real | the single match is a regex literal *inside the project's own scanner test*, not a cast |
| `<any>` / `: any` annotation | **0** real | the one match is inside a prose string in `ipython-tool.ts:117` |
| `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` | **0** | none |
| **`as never`** | **475** | **469 in test files, 6 in one production file** |
| non-null assertion `!` | 289 | counted and located, **not judged** (see below) |

**The oracle says: "No `any` cast, no `as never`, and no non-null `!` is used to
hide a genuinely undefined value."** `as never` is present 475 times, so the
literal condition is not met. **FAIL.**

Two things must be said honestly rather than folded into the number:

1. **The 469 test-file occurrences are a `ctx.plugin()` signature-mismatch idiom**
   (`await ctx.plugin(storageJsonPlugin as never, { root } as never)`), repeated
   across the suite's mount scaffolding. They are not hiding a genuinely undefined
   value; they are silencing a plugin-signature type error. That is a real
   distinction, and it is *still* a `as never` in the file the oracle names — the
   oracle does not carve out tests.
2. **The 6 production occurrences are all in one file, `durability-runner.ts`**
   (`src/durability-runner.ts:20,21,22,43`), the M4 process-kill rig. It is a
   runnable script, not a plugin, and `[read in source]` nothing imports it in
   production: its only in-tree references are its own usage comment and its own
   `argv` dispatch. So it is *not* on the boot path — but it is a non-test file in
   a production package, and the oracle does not carve that out either.

**The third clause is deliberately NOT decided.** Whether a given `!` "hides a
genuinely undefined value" is a judgement about the code, not a token match. The
scan therefore **counts and locates** all 289 and claims no verdict on them, and
says so in its own output. A scanner that guessed would be a second oracle.

**Deep imports.** `[measured]` 4 deep cross-package specifiers exist. The
oracle's phrase is "no **private symbol** is deep-imported across a package
boundary". `[measured]` the deep paths are **declared exports** — the target
package's `exports` map contains `"./src/*": "./src/*"` — so the *import path* is
public even though the symbol is not re-exported. This is recorded as the
qualification it is; the substantive half of the same fact is ID-01's finding that
one of those deep imports reaches a `.ts` file at runtime.

---

## 6. ID-06 — the pinned checkout is NOT clean

`[measured]` — `ID-06-pinned-checkout-state.txt`. Stimulus run exactly as specified:

```
$ git rev-parse HEAD
ddefc45fbc7f8e46dd73185e68295696d1297887          <- MATCHES the pinned commit

$ git status --porcelain
 M packages/deliverables/workspace-changes/src/index.ts
?? DSHhomem914/
?? data-artifacts/                                  <- NOT CLEAN
```

**Oracle: "The working tree is clean and HEAD equals `ddefc45f…`. Any tracked
modification, any staged change, or a moved HEAD is NOT PASS."**
HEAD matches; the tree is not clean. **FAIL.**

Characterised precisely, because the severity differs by entry `[measured]`:

| Entry | Kind | What it actually is |
|---|---|---|
| ` M …/workspace-changes/src/index.ts` | tracked, unstaged | **A line-ending artifact, not a content change.** `git diff --exit-code` = 0 (no content delta); `git diff --cached` empty (nothing staged); `git hash-object` on the worktree file = `c05787d9…` = `git rev-parse HEAD:…` — the **same blob id**. The worktree file is 7251 bytes of pure CRLF; the HEAD blob is 7086 bytes of pure LF; the two are identical after `CRLF→LF` (`True`, measured both directions). The checkout's `.gitattributes` says `* text=auto eol=lf` while the global `core.autocrlf` is `true`, and the file's mtime is 2026-09-19 19:19:47, i.e. it was written by an earlier checkout, not by this measurement. `git update-index --refresh` still reports "needs update". |
| `?? DSHhomem914/` | untracked | 9 files: a test home (`profiles/sdk/`, `sessions/…m914-sdk…`, `storages/…`) — a sibling agent's M9.14 measurement wrote a DSH home **inside the pinned checkout**. |
| `?? data-artifacts/` | untracked | 1 file: a content-addressed object under `objects/15/…` — an artifact store written inside the checkout. |

So: **no tracked content was modified, nothing is staged, and HEAD has not moved —
but the tree is not clean, and the oracle is unconditional.** The two untracked
directories are real pollution of the read-only reference checkout, written by
tooling that chose its cwd inside `D:\DSH\src\dsh-src`. The tracked ` M` is
benign in content but is still a tracked modification as far as the oracle and
`git status` are concerned.

**This is recorded as FAIL, not argued down.** Whether a line-ending-only
difference and two untracked output directories should count as "unmodified" is a
judgement for the spec's owner, not for the agent that ran the stimulus. What is
recorded here is the measurement, the characterisation, and the fact that the
literal oracle condition is not met.

---

## 7. What this slice does NOT establish

- **It does not certify the deployment.** Four of six IDENTITY cases pass. A
  family is not a deployment.
- **ID-01's measurement is a CONTROLLED LOCAL ROUTE, not a provider measurement.**
  `runtime_authorization.live_provider_budget_authorized` is `false`, so the model
  route was redirected to a keyless in-tree adapter. It proves the tool /
  transport / identity chain; it proves nothing about a provider integration.
- **ID-01's probe inserts no tool row.** The catalog is the product's own.
- **No claim is made about ID-01's finding being *fixed*.** It is reported.
  `publishImmutableObjectStream` is reachable as a built, public path
  (`lib/types/store.js`); the package simply does not export it, and a consumer
  reached into `src/` instead.
- **ID-05's third clause (non-null assertions) is not decided.** 289 are counted
  and located; judging them is a reading.
- **The spec is being filed into concurrently.** Ten agents share this tree. All
  measurements above are bound to the source digests recorded beside them; if a
  file changed after a measurement, the digest mismatch says so.

---

## 8. Files

| Path | What it is |
|---|---|
| `ID-01-run.txt` | the driver's transcript and all 23 checks |
| `runs/id01/verdict.json` | the judged artifact: rebuilds, build freshness, graph classification, probe output, checks |
| `runs/id01/graph.jsonl` | the raw 724-line resolution record from inside the booted host |
| `runs/id01/boot.json` | the probe's own output |
| `runs/id01/boot-stderr.txt` | the boot's stderr (empty) |
| `ID-01-graph-report.txt` | the graph read back and classified |
| `ID-01-source-import-characterisation.txt` | the three physical copies of the flagged module |
| `ID-01-revision-compare.txt` | the revision question, decided by the TypeScript compiler |
| `id01-driver.mjs`, `id01-graph-recorder.mjs`, `overlays/id01-overlay.yml` | the instruments |
| `ID-02-ID-04-identity-rederivation.txt` | pinned vs disk-derived identity, one-byte change, spec mutation, ledger relationship |
| `ID-03-no-inheritance.txt` | the three comparisons plus the identity check |
| `ID-05-clean-check-daily-work.txt`, `ID-05-clean-check-ipython.txt` | clean compiles, exit 0 |
| `ID-05-mutation-arm.txt` | the injected type error, caught |
| `ID-05-control-arm.txt` | `tsconfig.json` exits 0 on the same error |
| `ID-05-escape-hatch-scan.txt` | the construct scan with locations |
| `ID-05-src-tree-before.txt`, `ID-05-src-tree-after-clean.txt` | the tree digest, identical |
| `ID-04-verify-identity-live.txt` | `verify-identity.py`, 30/30, in the live tree |
| `ID-06-pinned-checkout-state.txt` | the raw git state and its characterisation |

**Instruments are recorded by sha256 in `runs/id01/verdict.json`**, including the
two that belong to T17 and are referenced by absolute path rather than copied, so
a later edit to either shows up as a hash mismatch rather than as a silent change
of instrument.
