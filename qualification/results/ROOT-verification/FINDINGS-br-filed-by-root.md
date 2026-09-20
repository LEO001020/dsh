# The NATIVE BRIDGE family was filed by the root agent

## Why this file exists

The NATIVE BRIDGE family (BR-01..BR-12) was assigned to an agent that produced no
files in roughly forty minutes — `qualification/results/V4-bridge/` never
appeared. Two status checks went unanswered. Rather than leave twelve mandatory
cases unfiled, **the root agent filed them** from evidence that already existed,
and this file records exactly what was and was not measured, so a reader can tell
this filing from one produced by a family that ran its own probes.

## What was measured, and by whom

**By the root agent, just now, on the current build:**

| Command | Result |
|---|---|
| `vitest run src/programmatic-scope.test.ts` (cwd `packages/dsh-daily-work`) | **42 passed / 42**, exit 0 → `BR-scope-tests.txt` |
| `vitest run src/bridge-seam.test.ts` (cwd `packages/dsh-ipython`) | **17 passed / 17**, exit 0 → `BR-bridge-tests.txt` |
| `node qualification/runners/import-graph.mjs packages/dsh-ipython` | **5 reachable / 3 unreachable** of 8 non-test modules → `BR-import-graph.txt` |

**By the T7 agent earlier, cited rather than re-derived:**

| File | What it establishes |
|---|---|
| `qualification/results/T7-bridge/FINDINGS.md` | the full report; the mechanism PASS separated from the wiring FAIL |
| `qualification/results/T7-bridge/wiring.json` | `productionCallSites` for `new BridgeServer` is `[]` |
| `qualification/results/T7-bridge/measurement.json` | a real cell's `dsh.call` reaching `ctx.tools.execute`, observed from the registry side |

## The mapping, and it is 1:1 on the scope route

The `programmatic-scope.test.ts` suite carries `BRG-01`..`BRG-08` describe blocks
that map directly onto the spec's BR cases. That is why eleven of the twelve could
be filed from one test run:

| Spec case | Establishing test | Verdict |
|---|---|---|
| BR-01 | `BRG-01` one pipeline for native, PTC and the scope | PASS |
| BR-02 | `BRG-02` revocation mid-scope takes effect; `names()` is a live read | PASS |
| BR-03 | `BRG-03` value delivery returns the declared canonical type | PASS |
| BR-04 | `BRG-04` runs EXACTLY ONCE; the reference carries the POST-POLICY value | PASS |
| BR-05 | `BRG-05` a post-policy BLOCK leaves no recoverable original | PASS |
| BR-06 | `BRG-06` a wrapper never waits for a slot from the pool it holds | PASS |
| BR-07 | `BRG-07` close with calls in flight; every disposition recorded; idempotent | PASS |
| BR-08 | `BRG-08` control notices keep semantics; bulk payloads stay out of context | PASS |
| BR-09 | `bridge-seam.test.ts` — the host owns the lease, the client cannot mint one | PASS |
| BR-10 | the scope close is explicit and reports a disposition per call | PASS |
| BR-11 | the two `contentProjection` arms; the projection is counted | PASS |
| BR-12 | **nothing on the product route** | **FAIL** |

## BR-12 is FAIL, and the reason is the family's headline

**BR-12 — "the deployment depth ceiling cannot be lifted by the caller."** The
oracle is about the deployment, and on the deployment route the bridge is never
started: `new BridgeServer` has **zero production call sites**, and `bridge.ts` /
`native-call.ts` are **outside the transitive closure of every declared entry
point** — measured by two independent instruments that agree (T7's symbol-level
probe, and `import-graph.mjs`'s compiler-based closure, which reports 5 reachable
and 3 unreachable non-test modules).

**Recorded as FAIL rather than PASS because the case is about the deployment, not
about the mechanism.** A ceiling that cannot be lifted through a bridge that is
never constructed is not a ceiling that is enforced; it is a mechanism with no
caller. This is `G-SEAM-34`, and it is the same defect class as `G-SEAM-31`.

**The combined statement, which is the family's real finding**: the FORBIDDEN seam
is correctly absent — `ctx.terminalController` appears in no production file, and
T7 measured that three ways — AND the sanctioned one is unwired. So today the
model's Python has no tool access through either path, and because `ipython` is the
model's only execution surface (27 tools, `pwsh` and `bash` absent), that is not
academic.

## What this filing does NOT claim

- **The eleven PASSes are mechanism results.** They establish that the scope and
  bridge machinery behaves as the oracles describe when it is driven. They do not
  establish that a user can reach it, and BR-12 says so explicitly.
- **No new probe was written.** Every measurement above is either a test run I
  executed or a file T7 produced and I cited. Nothing was inferred.
- **The label collision applies here too** (G-SEAM-38): `bridge-seam.test.ts`'s own
  internal labels (`T7-01`..`T7-08`) are not the spec's `BR-*` ids. The mapping
  above is by ORACLE, and a reader should check the oracle text rather than the
  test names.
