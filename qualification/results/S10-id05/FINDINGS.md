# S10 / ID-05 — the `as never` idiom and the typecheck false pass

**Writer:** S10 · **worktree:** `D:\DSH\work\wt-s10` · **branch:** `wt/s10`
**Identity measured under:** this worktree, tsc `Version 6.0.3` from
`D:\DSH\src\dsh-src\node_modules\typescript\bin\tsc`, resolving
`packages/*/tsconfig.check.json`.

**HEADLINE.** Yes — `as never` masks real type errors, at **7 sites**, not one.
Six are now fixed at the type level with no behaviour change. **One is left in
place and reported rather than papered over**: it hides a fabricated `Session`
object and its honest fix is a topology change to a crash rig, which is outside
this slice. The recorded count of 10 non-test occurrences was also wrong: the true
number at the recorded revision is **10 by D4's method and 10 by the archived
scanner**, but the raw-grep numbers in the assignment (48) are prose matches, and
the tree has since drifted to 11.

---

## 1. THE ORACLE, REPRODUCED (both halves)

### Half 1 — clean tree, tests included, exit 0

| package | files in program | production | test | result |
|---|---|---|---|---|
| `dsh-daily-work` | 92 | 39 | 53 | exit 0, 0 diagnostics |
| `dsh-ipython` | 24 | 13 | 11 | exit 0, 0 diagnostics |

Evidence: `01-clean-check-dsh-daily-work.txt`, `02-clean-check-dsh-ipython.txt`.

### Half 2 — the mutation arm, and the control arm the oracle demands

`ID-05` says *"a green run under `tsconfig.json` alone is NOT PASS"*. That is a
claim about a **contrast**, so both compiles ran inside ONE mutation window:

```
injected:  const __s10InjectedTypeError: number = 's10-injected'   (a TYPE error)
dsh-ipython      bridge-seam.test.ts:66   tsconfig.check.json -> exit 2, TS2322 at (66,7)
                                          tsconfig.json       -> exit 0, NO output
dsh-daily-work   authorization-path.test.ts:61  same shape
restore:   byte-exact, sha256 asserted, both packages
```

Evidence: `03-injection-arm-dsh-ipython.json`, `04-injection-arm-dsh-daily-work.json`.
Both report `oracle_established: true`.

**A defect I found in my own first harness, recorded because it is the same class
as R2-F11F10's `' M'` entry.** The first version read/wrote the test file in
**text mode**, and Python's newline translation rewrote its 1320 LF endings to
CRLF. `git status` reported the file **CLEAN anyway**, because `.gitattributes`
normalizes `*.ts` to LF — so the damage was invisible to git while the on-disk
bytes had changed. The harness now uses bytes and asserts the sha256 of the
encoded file. This is why `restore_byte_exact` is a field and not an assumption.

---

## 2. RE-COUNT: the drift is now RECONCILED (it was not before)

The assignment's raw grep is **not a measurement of the construct**. `grep -c "as
never"` matches English prose: on this tree **618 raw substring hits vs 332 real
casts**, and the 48 "non-test hits" the coordinator measured are mostly
`was never written`, `never a product question`, `never established`.

Running the **archived V1 scanner** (`qualification/results/V1-identity/id05-escape-hatch-scan.py`,
comment-stripped) over blobs at each revision:

| revision | total | test | non-test | note |
|---|---|---|---|---|
| `733c31b` (D4 decision commit) | 484 | 474 | **10** | comment-stripped |
| `733c31b` **without** comment stripping | **488** | **478** | **10** | **exactly D4's recorded number** |
| `fef7612` (HEAD at slice start) | 520 | 509 | **11** | +1 from `data-plane.ts:720` |
| after this slice's fixes | 511 | 509 | **2** | 9 non-test casts removed |

**D4 did not strip comments; the archived V1 scanner does.** That single
methodological difference is the entire 13-count discrepancy v2 recorded as
`NOT RECONCILED` — and it is now reconciled:
`488 = raw substring count at D4`, `484 = comment-stripped count at D4`.
The `unresolved_counts` entry in
`qualification/specs/acceptance-spec.trusted-local-v2.provenance.json` can be
closed with this measurement.

The non-test **+1** (10 → 11) is attributable: `data-plane.ts:720`
(`attachmentId: input.attachmentId as never`) was added by commit `983c8aa`
("R6: the dsh.data high-throughput programmatic data plane"), after D4 measured.

---

## 3. THE REAL WORK — all 11 non-test occurrences, one at a time

Method: `s10-cast-removal-probe.py` removes **exactly one** occurrence per compile
and reports the diagnostic that appears. One at a time, because a single removed
cast can cascade and a batch removal produces diagnostics that cannot be
attributed.

**7 of 11 are genuine MASKs.** Each produced exactly ONE isolated diagnostic:

| file:line | source | revealed error | judgement |
|---|---|---|---|
| `dsh-daily-work/src/durability-runner.ts:37` | `ctx.plugin(Storage, {} as never)` | **TS2345** `Argument of type '{}' is not assignable to parameter of type 'undefined'` | **clause (b) — the oracle's literal example. FIXED** |
| `durability-runner.ts:38` (config) | `{ root } as never` | **TS2345** `Argument of type '{ root: string; }' is not assignable to parameter of type 'never'` | **FIXED** |
| `durability-runner.ts:39` (config) | `{ backend: 'json' } as never` | **TS2345** `Argument of type '{ backend: string; }' is not assignable to parameter of type 'never'` | **FIXED** |
| `durability-runner.ts:65` | `root: {...} as never` | **TS2322** `Type 'string' is not assignable to type 'SessionId'`; with the id branded, **TS2740** — missing **24** members of `Session` | **REPORTED, NOT FIXED** (§4) |
| `dsh-daily-work/src/v4-scope-probe.ts:75` | `attachmentId: 'cafebabe' as never` | **TS2322** `Type 'string' is not assignable to type 'AttachmentId'` | **FIXED** |
| `dsh-ipython/src/v4-bridge-probe.ts:222` | `attachmentId: 'aaaaaaaa' as never` | **TS2322** `Type 'string' is not assignable to type 'AttachmentId'` | **FIXED** |
| `dsh-ipython/src/v4-bridge-probe.ts:236` | `} as never)` (a hand-built `UserMessage`) | **TS2345** `Argument of type '{ role: "user"; content: [...] }' is not assignable to parameter of type 'UserMessage'` | **FIXED** |

**3 are clean removals** (no diagnostic appeared) — and one of those is a *latent
hole*, not a clean cast:

| file:line | source | removal | judgement |
|---|---|---|---|
| `durability-runner.ts:38` (plugin) | `storageJsonPlugin as never` | clean | clause (a) noise — removed anyway (§4) |
| `durability-runner.ts:39` (plugin) | `storageDomainPlugin as never` | clean | clause (a) noise — removed anyway (§4) |
| `data-plane.ts:720` | `attachmentId: input.attachmentId as never` | clean **because the type was already `any`** | **FIXED** — see below |
| `v4-bridge-probe.ts:365` | `ctx.tools.get('v4_target' as never)` | clean | redundant; left in place, intent-documenting |

**`data-plane.ts:720` is a finding in its own right.** Removing the cast reports
nothing, which looks like a clean removal. It is not: `#attachments()` is typed
`NonNullable<ReturnType<Context['get']>>`, and `Context.get` declares a **catch-all
overload returning `any`** (`vendor/cordis/src/reflect.ts:26`). `ReturnType` picks
the *last* overload, so the accessor's type is `any` and the whole call is
unchecked. Measured with a scratch probe: assigning that port to
`{fieldThatDoesNotExist: number}`, to `number`, and to `() => void` **all compile**.
So the cast suppressed nothing *here* only because an `any` had already erased the
check upstream. Four accessors use this pattern in `data-plane.ts`
(`#web`, `#attachments`, `#sessionQuery`). Branding at the boundary is the local
fix; the `any` erasure is reported as a finding for the root agent.

---

## 4. WHAT I FIXED, AND WHY EACH FIX IS TYPE-LEVEL ONLY

| file | change | why it is behaviour-neutral |
|---|---|---|
| `durability-runner.ts:37` | `ctx.plugin(Storage, {} as never)` → `ctx.plugin(Storage)` | `Storage` declares **no** `Config`; `resolveConfig` returns the config unchanged when `runtime.Config` is absent (`fiber.ts:51`), and the old `{}` was ignored. Omitting it is the oracle's own instruction. |
| `durability-runner.ts:38-39` | dropped the cast on the **plugin** argument AND the config | `GetPluginParameters` already infers `(ctx, config: Config)` from each plugin's `apply`, so the config is now checked against the plugin's real `Config` interface. **The plugin-position cast was the CAUSE of the config-position error**: `GetPluginConfig<never>` is `never`. Measured: removing both casts compiles clean. |
| `v4-scope-probe.ts:75`, `v4-bridge-probe.ts:222` | `'cafebabe' as never` → `AttachmentId('cafebabe')` | `AttachmentId` is the package's own compile-time brand constructor: `brandString<AttachmentId>` returns the value unchanged, validating nothing (`util/brand/src/index.ts:28`). |
| `v4-bridge-probe.ts:236` | hand-built object → `createUserMessage({content, source})` | `createUserMessage` spreads the input and stamps `role: 'user'` + a fresh `id` (`llm/message.ts:204`). Same idiom the product uses at `core/tools/src/ptc.ts:633`. |
| `data-plane.ts:720` | `as never` → `AttachmentId(input.attachmentId)` | Brand constructor again — same string, no validation. |

**Clause (a) verified as the oracle claims.** `ctx.plugin(storageJsonPlugin, { root })`
compiles clean with the plugin-position cast removed, exactly as the oracle says.
This was measured in `11-mechanism-probe.ts` (a scratch file compiled under
`tsconfig.check.json`, then deleted from `src/`) and again in
`authorization-path.test.ts` (both casts on lines 144-145 removed together → exit 0).

**The one I did NOT fix, with its file:line and what it would take.**
`packages/dsh-daily-work/src/durability-runner.ts:93`:
`root: { session: { header: { id: 'root-session' } } } as never`.
Removing it reports **TS2322** (`string` is not `SessionId`); branding the id with
`SessionId(...)` reveals the deeper **TS2740** — the literal is missing **24
required members** of the `Session` class (`log`, `surfaceManager`, `surface`,
`inheritedEventCount`, …). The honest fix is to mount the real `AgentLoop` in this
rig and use `ctx.agentLoop.create(SessionId('root-session'), …)` as the sibling
rigs do (`concurrency.test.ts:151`). That is a **topology change to a crash rig
whose child is SIGKILLed mid-run** — outside "type-level fixes only, do not change
behaviour". Replacing the cast with a bigger cast or a fabricated 24-member object
would be the exact fabrication ID-05 exists to catch, so it is **left in place,
annotated, and reported**.

**Reachability, stated so it is not over-read.** `durability-runner.ts` is NOT in
the package's `exports` and has no production importer — a test asserts this
(`durability-advanced.test.ts:1080`). It is a hand-run CLI. So the remaining mask
is an **oracle violation in a test rig, not a product defect**. Both facts are
true; the distinction is the finding.

---

## 5. THE TEST OCCURRENCES: 509, CHARACTERISED — NOT SWEPT

**I examined 12 of 509 by mutation and characterised all 509 by shape.** I did not
sweep them, and I am not claiming the count can be driven to zero mechanically.

| shape | test count | representative probe | verdict |
|---|---|---|---|
| `plugin-arg` `ctx.plugin(x as never, …)` | 280 | `authorization-path.test.ts:144` | **MASK** (the config arg) — but the plugin cast is the cause; both removed → exit 0 |
| `object-literal` `{…} as never` | 82 | `authorization-path.test.ts:517` / `:518` | **MASK** / **REMOVABLE** — *same shape, different verdicts* |
| `call-argument` `f(x as never)` | 55 | `control-plane.test.ts:373`, `:378` | **REMOVABLE** (both) |
| `other` | 44 | `cost.test.ts:166`, `:185` | **MASK** — TS2740, a fabricated `Agent` |
| `config-arg` `ctx.plugin(P, c as never)` | 25 | `capacity-v8-probe.test.ts:152`, `capacity.test.ts:1138` | **MASK** — TS2345 `'{}'` is not `undefined`; **clause (b) in test files** |
| `object-property` `k: v as never` | 23 | `authorization-path.test.ts:196`, `:381` | **MASK** — TS2322 `string` is not `ToolCallId` |

**The finding that matters:** the test casts are a **mixed population, not one
idiom**. `object-literal` gave one MASK and one REMOVABLE at two adjacent lines.
`plugin-arg` is a MASK whose *cause* is the plugin cast. And **`ctx.plugin(Storage,
{} as never)` — the oracle's literal clause-(b) example — occurs 25 times in test
files, across 13 files** (`capacity.test.ts` ×3, `durability-records.test.ts` ×6,
`f5-admission.test.ts` ×3, `tool-protocol.test.ts` ×3, `durability-advanced.test.ts`
×2, and 8 more), every one of them a clause-(b) violation by the oracle's own
wording.

A sweep that removed all `plugin-arg` casts mechanically would be **correct** for
that shape (measured: both casts off → exit 0). A sweep over `object-literal` or
`config-arg` would break compilation, because those are genuine masks. That is why
this is a round-3 slice with per-shape review, not a sed.

---

## 6. THE GATE, AND ITS MUTATION TEST

`helpers/typecheck.mjs` now runs a second check after the compile: it counts
**non-test** `as never` casts (comments stripped) and fails if the count **grew**
against `qualification/results/S10-id05/as-never-baseline.json`.

**Why a ratchet and not zero.** The count went 11 → 2 in this slice. Demanding zero
today would be a gate nobody could pass honestly without a per-site sweep of 509
test casts. Forbidding *growth* is enforceable now and stops the hole widening.
The gate says explicitly that it is a ratchet, not a proof that any individual cast
is justified.

**Mutation test (required):**
```
$ python -c "...replace AttachmentId('cafebabe') with 'cafebabe' as never..."
$ node helpers/typecheck.mjs
--- escape-hatch gate (ID-05, non-test `as never`) ---
[FAIL] non-test `as never` casts grew from 2 to 3. ...
         packages/dsh-daily-work/src/v4-scope-probe.ts:82  attachmentId: 'cafebabe' as never,
typecheck: FAIL -- 1 check(s) did not pass
EXIT=1
$ # restore
$ node helpers/typecheck.mjs  -> [ok] 2 non-test cast(s); baseline allows 2   EXIT=0
```
Evidence: `14-gate-mutation-test.txt`. The gate **goes red, names the added cast,
and returns to green on restore** — it is not a guard that can never fire.

Also verified: with the baseline file **absent**, the gate reports `NO_BASELINE`
and fails, rather than defaulting to a green.

---

## 7. TEST RESULTS

| command | result |
|---|---|
| `node helpers/typecheck.mjs --pkg dsh-daily-work` | exit 0, 92 files (39 production + 53 test), 0 diagnostics |
| `node helpers/typecheck.mjs --pkg dsh-ipython` | exit 0, 24 files (13 production + 11 test), 0 diagnostics |
| `node helpers/typecheck.mjs` (both + gate) | **exit 0**, gate `[ok] 2 non-test cast(s); baseline allows 2` |
| `vitest run src/data-r6.test.ts` | 38 passed / 0 failed |
| `vitest run src/durability-records.test.ts` | 25 passed / 0 failed |
| `vitest run src/durability-advanced.test.ts` | 33 passed / 0 failed |
| `vitest run src/bridge-seam.test.ts` | 17 passed / 0 failed |

All four test files cover code I changed (`data-plane.ts`,
`durability-runner.ts`, `v4-bridge-probe.ts`). Run **one file at a time**, per the
CPU discipline.

---

## 8. EVIDENCE INDEX — `qualification/results/S10-id05/`

| file | what it is |
|---|---|
| `01-clean-check-dsh-daily-work.txt`, `02-clean-check-dsh-ipython.txt` | clean test-inclusive compiles |
| `03-injection-arm-dsh-ipython.json`, `04-injection-arm-dsh-daily-work.json` | mutation + control arm, byte-exact restore |
| `05-as-never-scan.txt`, `16-final-as-never-scan.txt` | shape histogram before/after |
| `06-archived-scanner-on-current-tree.json` | the V1 scanner re-run on this tree |
| `07-drift-attribution.txt` | the count reconciliation across revisions |
| `08-removal-probe-*.json`, `09-*`, `10-*` | per-occurrence removal probes |
| `11-mechanism-probe.ts` | the scratch probe that established clauses (a)/(b) |
| `12-test-shape-probe.json`, `13-test-shape-probe.txt` | per-shape test characterisation |
| `14-gate-mutation-test.txt` | the gate going red, then green |
| `15-final-typecheck-after-fixes.txt` | final green run |
| `as-never-baseline.json` | the ratchet's baseline + the 2 justifications |
| `s10-*.py` | the harnesses, re-runnable |

---

## 9. UNRESOLVED UNKNOWNs

1. **Of the 509 test-file casts I mutated and compiled 12** (2 per shape, one shape
   got 2). The other **497 were characterised by shape only** — I know which
   syntactic shape they belong to, not whether each one masks. Since
   `object-literal` returned one MASK and one REMOVABLE at adjacent lines, the
   per-shape verdicts are **not** a prediction about individual instances.
2. **The remaining mask at `durability-runner.ts:93` is unresolved by design.** Its
   honest fix (mount a real `AgentLoop` in the crash rig) is a topology change I
   was told not to make. Whether that rig still measures what it claims after such
   a change is unknown to me.
3. **The `any` erasure via `ReturnType<Context['get']>`** is measured for
   `data-plane.ts` and reported, but I did not audit what it lets through in the
   other three accessors (`#web`, `#sessionQuery`) or elsewhere in either package.
   This is a hole **wider than `as never`** and it is outside this slice.
4. **I did not run the full suites.** Per the brief's CPU discipline I ran four
   individual files. A change to `data-plane.ts` is reachable from more tests than
   `data-r6.test.ts`; the type-level nature of the change makes a behavioural
   regression unlikely but **not measured**.
5. **`dsh-ipython` gained an import of `@deepseek-ai/dsh-attachment`**, resolved by
   re-running `link-all-dsh.ps1` (which derives its link set from source imports).
   The package's `package.json` was **not** changed, so the declared dependency
   graph and the physical link farm now disagree by one entry. Whether that is the
   project's intended convention is unverified.

## 10. CLAIMS I AM NOT MAKING

- **Not** claiming `as never` is eliminated. 511 remain (509 test, 2 non-test).
- **Not** claiming the 2 remaining non-test casts are justified. One is a
  **known mask**, recorded as such; the other is redundant-but-intent-documenting.
- **Not** claiming the 509 test casts are harmless. I measured **five** of the six
  shapes as masking at their representative site.
- **Not** claiming a mechanical sweep is safe. Two of six shapes would break the
  build if swept blindly.
- **Not** claiming the gate proves any cast justified. It is a ratchet on a count.
- **Not** claiming product impact from the remaining mask: `durability-runner.ts`
  is in no production import graph.
- **Not** claiming `tsc` success says anything about runtime behaviour. The four
  test files I ran are the runtime evidence, and they are four files.
- **Not** claiming I reconciled the v2 `unresolved_counts` entry in the spec — I
  produced the measurement that closes it, but the spec file is not mine to edit.
