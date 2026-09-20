# ID-01 verdict — artifact identity, re-measured with both attacks

Writer S12, wave 2. Measured 2026-09-20 in `D:\DSH\work\wt-s12` (branch `wt/s12`),
DSH_HOME `D:\DSH\home\s12`. Three boots, one at a time, on harness-chosen free ports.

## The oracle, verbatim from `acceptance-spec.trusted-local-v2.definition.json`

> **stimulus**: Boot the built launcher `node apps/cli/lib/bin.js --profile
> daily-candidate`, then swap it for a different build or load `src/` instead of
> `lib/`, and repeat the first successful tool call.
>
> **oracle**: The first tool call actually succeeds and the resolved module graph is
> recorded: every `@deepseek-ai/*` specifier resolves under
> `D:\DSH\src\dsh-src\packages\*\lib\`, and sha256 of the launcher equals
> `deployment.inputs.artifact_sha256`. A run whose only success is `--help`, or whose
> graph mixes `src` and `lib`, is NOT PASS.

## VERDICT: PASS (on the clause this slice owns: no `src/` in the graph)

| clause | baseline | verdict |
|---|---|---|
| the resolved module graph was recorded and is non-empty | 715 lines, 222 distinct specifiers | **PASS** |
| no `@deepseek-ai/*` specifier resolves to a source (.ts) file | `fromBuilt=221 fromSource=0 fromOther=1` | **PASS** |
| the graph does not mix src and lib for one specifier | `mixed=[]` | **PASS** |
| sha256 of the launcher equals `deployment.inputs.artifact_sha256` | `69c49c871735dc7e…` == `69c49c871735dc7e…` | **PASS** |
| the first tool call actually succeeded (not `--help`-only) | `read`, `isError=false` | **PASS** |
| the tool result carries the file's own text | the file's 1 line, verbatim | **PASS** |

**Re-measured, not quoted.** R2-F4 recorded `fromBuilt: 221, fromSource: 0` on
`wt-r2f4`. R5/R4/S1 have changed the plugin graph since, so this is a fresh boot.
The counts reproduce **exactly**: 221 built, 0 source, 1 other, 222 distinct
specifiers, and the same 213 / 7 / 1 split across `packages\*`, `vendor\*` and
`node_modules`. A graph that had changed would have shown it here.

**The first tool call is real, not a `--help` success.** The probe drove a `read`
tool call through the composed profile and the result carries the file's own text:

```
requested={"name":"read","callId":"t17-first-call"}  isError=false
text="<path>…first-call-input.txt</path>\n<content>\n1: ID01_FIRST_TOOL_CALL_ROUND_TRIP\n…"
```

## The two attacks, and the identity check catches each

The oracle's stimulus is not "boot and look" — it says *"then swap it for a
different build or load `src/` instead of `lib/`, and repeat"*. A gate nobody has
watched fail is not evidence (round-2 §3.2). Both attacks were run as real boots.

### ARM B — swapped build: caught by the launcher-sha256 clause

The swap artifact is the checkout's **own other build face**:
`apps/cli/lib/types/bin.js` is the `tsc -b` output that `tsdown` consumes to produce
the pinned bundle — a genuine, shipped, executable build of the same source at the
same commit, simply not the artifact the lock pins. It was **executed**, by its own
path, with a resolution farm of absolute junctions, and it printed its own identity:

```
the pin names   …/apps/cli/lib/bin.js          sha 69c49c871735dc7e
the boot RUNS   …/swapped2/apps/cli/lib/types/bin.js  sha fe01631ecb3141bb
that build reports version "0.1.6-alpha.2-UNBUNDLED"
```

Result — **exactly one clause failed**, and it is the one designed for this:

| clause | swapped-build arm |
|---|---|
| graph non-empty | ok (715 lines, 222 specifiers) |
| no source resolution | **ok** — `fromBuilt=221 fromSource=0 fromOther=1` |
| no mixed specifier | ok |
| **sha256 of the launcher == pin** | **FAIL** — `onDisk=fe01631ecb31… pinned=69c49c871735…` |
| first tool call succeeded | **ok** — the swapped build booted and served the call |
| tool result carries the file text | ok |

This is the discrimination the clause exists for. The swapped build is a *working*
product — it booted, composed the same profile and served the same tool call — and
the identity check still refuses it, because the bytes are not the pinned bytes.
**ARM B VERDICT: FAIL (as required).**

### ARM C — `src/` instead of `lib/`: caught by the graph clause

The real defect shape, not a synthetic one. A `src/` deep import was injected into a
**production** source file (`packages/dsh-daily-work/src/artifacts.ts`), then the
package was **rebuilt with the project's own compiler** so the emitted `lib/` really
carried it. Proven from the emitted artifact, not the source:

```
emitted lib/artifacts.js:2403  import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts';
```

Result — **exactly one clause failed**:

| clause | src-injection arm |
|---|---|
| graph non-empty | ok (720 lines, 223 specifiers) |
| **no source resolution** | **FAIL** — `fromBuilt=221 fromSource=1 fromOther=1`; offender `@deepseek-ai/dsh-attachment-local/src/store.ts -> …\attachment-local\src\store.ts` |
| no mixed specifier | ok |
| sha256 of the launcher == pin | ok |
| first tool call succeeded | ok |
| tool result carries the file text | ok |

**ARM C VERDICT: FAIL (as required).** The offender path is the pinned checkout's
real `src/store.ts`, resolved by the product's own loader during a real boot.

### Restore, asserted

`git checkout -- src/artifacts.ts`, then rebuild. Verified byte-exact:

```
sha256 after restore: 8dac7929894e0f9938c689df27704b21755e4a32efa0562275bb25fbe6fac703
expected             : 8dac7929894e0f9938c689df27704b21755e4a32efa0562275bb25fbe6fac703
git status --porcelain src/artifacts.ts -> empty
emitted import form in lib/artifacts.js -> 0 occurrences
```

## The gate, mutation-tested end to end

`no-src-imports.test.ts` was watched failing against a real emitted defect, not only
its own in-file negative control. Full cycle in `F4-gate-mutation-e2e.txt`:

| step | command | result |
|---|---|---|
| gate BEFORE | `vitest run src/no-src-imports.test.ts` | **5 passed** |
| inject + rebuild | append `src/` import to `artifacts.ts`, `tsc -p tsconfig.json` | tsc exit 0; emitted `lib/artifacts.js` carries it |
| gate AFTER | same | **3 failed / 2 passed, exit 1** |
| restore + rebuild | `git checkout --`, `tsc -p tsconfig.json` | sha byte-exact |
| gate AFTER RESTORE | same | **5 passed** |

The three that went red are the load-bearing ones, by name:

```
FAIL the emitted `lib/` of every package is clean, and the check is not vacuous
FAIL non-test `src/` is clean too, so the defect cannot return one build away
FAIL the detector FAILS when a forbidden specifier is injected, then the file is restored
```

The two that stayed green are the ones that do not read the mutated tree (the frozen
test-side allowlist, and the synthetic emitted-form assertion). A gate whose green
survives a real defect would have shown it here.

## Independent scan — not trusting the gate's own `PACKAGES` constant

`scan-src-imports.mjs` discovers packages from the filesystem rather than from a
constant, so a package added later cannot be invisible to both. It parses with
`ts.preProcessFile` rather than grepping, because `artifacts.ts:33` cites the
forbidden path in a documentation comment and a grep reports that comment as an
import (measured: a plain `grep -rn` returns 1 hit; the parser returns none).

```
packages discovered: 2 (dsh-daily-work, dsh-ipython)
files scanned: 168  (52 production src + 64 test src + 52 emitted lib)
PRODUCTION OFFENDERS: 0
```

The only `src/` specifiers anywhere are the three test files already frozen and
justified in the gate's `JUSTIFIED_TEST_IMPORTS` — the scan's list matches that
allowlist exactly, in both directions.

## S10 / S1 risk check

- **`as never` (S10)** cannot introduce a module specifier: it is a type-only
  assertion and TypeScript erases it. The 31 hits in emitted `lib/` are the English
  word "never" inside prose comments and message strings, not casts.
- **Tool rows (S1)** are mounted by package NAME, not by path, so a row change alters
  a resolution *target* — and the answer to "does that target resolve to lib or src"
  is the boot graph itself, which is clean in all three arms.
- **Coverage gap found, recorded not fixed:** `homelock.ts` holds two specifiers in a
  `const` variable, so the parser cannot see them and **neither the gate nor my scan
  tests them**: `'koffi'` and `'@deepseek-ai/node-addon-system/flock'`. Both were
  measured to resolve to **built** artifacts (`…/koffi/index.cjs` and
  `…/native/system/packages/entry/lib/flock.js`), so neither is a defect today. But a
  computed specifier is precisely the one way to name a `src/` path that a parse-based
  gate cannot see. Details in `S10-S1-risk-check.txt` §4.

## Reported, not asserted — a divergence in the oracle's literal wording

The oracle says every specifier resolves **under `packages\*\lib\`**. The measured
graph also contains **7 rows under `vendor\*\lib\`** (`@deepseek-ai/cordis`,
`cosmokit`, `schemastery` and four `cordis-plugin-*`) and **1 under
`node_modules/.pnpm/`** (`@deepseek-ai/libreoffice-kit`). All are built `lib/*.js`
files, so they are not source contamination — but they are not under `packages\`
either. R2-F4 classified them as built and recorded the same split; I reproduce that
and flag it rather than folding it into a silent pass. It is also worth noting the
one OTHER row is `@deepseek-ai/dsh-web-frontend/package.json`, a **manifest read**
by `apps/web`, not a module import.

## UNRESOLVED UNKNOWNs

1. **Whether the oracle intends `vendor\*\lib\` to satisfy "under `packages\*\lib\`".**
   I report the split; I do not decide it. A literal reading would fail 8 rows that
   are unambiguously built.
2. **Whether the two computed specifiers in `homelock.ts` would be caught by any
   other check.** I could not find one; the gate parses, and a parser cannot see a
   variable. Not fixed, because both current values are correct and expanding the
   gate's scope is not this slice's call.
3. **Whether the daily-candidate profile as shipped (not this worktree's rewritten
   copy) resolves identically.** I measured the copy with `link:` rewritten at
   `wt-s12`, which is what a writer is required to measure; the repo's own
   `package.json` names the main checkout.
4. **Whether a provider integration works.** Not measured and not measurable here:
   the overlay disables `llm-deepseek` and routes to a keyless local adapter.

## CLAIMS I AM NOT MAKING

- **Not claiming a live model route works.** Every run here is a CONTROLLED LOCAL
  ROUTE through a keyless mock adapter. It proves the module graph and the tool
  chain, not a provider integration.
- **Not claiming `fromBuilt=221` is a permanent property.** It is a measurement of
  this tree at this commit; any plugin-graph change moves it, which is why it was
  re-measured rather than inherited from R2-F4.
- **Not claiming the gate covers every way to name a `src/` path.** It cannot see the
  two computed specifiers, and I say so above.
- **Not claiming the swapped-build arm reproduces a specific real attack.** It
  demonstrates that the identity clause discriminates a working-but-unpinned build;
  it is a controlled substitution, not an incident report.
- **Not claiming the F4 defect class is eliminated.** The gate refuses new instances
  in the two packages that exist; whether a third package would be covered is
  untested (the discovery rule is written to extend).
- **Not claiming `ID-01` PASS makes `ID-06` PASS, or vice versa.** They are separate
  cases and ID-06 is a FAIL — see `ID-06-verdict.md`.
