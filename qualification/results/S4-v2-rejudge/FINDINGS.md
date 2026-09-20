# S4 — the 13 v1 FAILs re-judged under the v2 definition, one case at a time

**Slice:** re-judge the 13 v1 FAILs (`ID-01, ID-05, ID-06, CMP-02, CMP-04, IPY-13,
IPY-15, BR-07, DATA-09, DATA-11, REC-09, REC-10, CAP-10`) under
`qualification/specs/acceptance-spec.trusted-local-v2.definition.json`, with a real
run per case, and file the verdicts in the existing v2 result schema.

**Worktree/branch:** `D:\DSH\work\wt-s4` / `wt/s4`
**Measured at:** `fef7612fa427ce04aed8a329dd22a80fd8fc8e77`, `DSH_HOME=D:\DSH\home\s4`
**Deliverable:** `qualification/results/S4-v2-rejudge/verdicts.json` (13 cases, in the
schema of `trusted-local-v2.88834ae45ad7/verdicts.json`)

---

## 1. THE VERDICT TABLE

| case | verdict | the run that establishes it | falsification attempted |
|---|---|---|---|
| **ID-01** | **PASS** | `s4-id01-driver.mjs` — real built-launcher boot, 23/23 checks; graph 723 lines / 222 specifiers, `fromSource 0` | injected the v1 `src` deep import into `artifacts.ts`; the same driver went 22/23 FAIL with v1's **byte-identical** offender |
| **ID-05** | **FAIL** | `tsconfig.check.json` clean exit 0 both packages; injected TS2322 makes it exit 2; `tsconfig.json` control **misses** it (exit 0); `helpers/typecheck.mjs` exit 0 | the failing clause was decided by experiment, see §3 |
| **ID-06** | **FAIL** | `git status --porcelain` → one ` M` entry; HEAD = `ddefc45f…`; blob ids equal; control repo reproduces the mechanism | tried to clear it via `update-index --refresh` and `git add` on **copies** of the index — neither can clear it, because there is no content delta |
| **CMP-02** | **PASS** | `s4-cmp-driver.mjs` — one composed boot, 16/16; row present, mode `danger-full-access`, `workspaceRoot` absolute | disabled `sandbox-policy` → 8/16 FAIL, dependent rows PENDING (`workflow-ptc … waiting for sandboxPolicy`) |
| **CMP-04** | **PASS** | same boot; `ipython` present, `work` present, `pwsh` absent, `error` null, `presetRoots` names the home; **count 27 recorded verbatim** | re-enabled `tool-pwsh` only → **exactly one** check red, count 27→28 |
| **IPY-13** | **FAIL** | `vitest … -t IPY-13` → clause 1 **PASSES**, clause 2 **FAILS**: `measuredAttributedToLaterCell:true, measuredLateCount:0, verdict:"CLAUSE_NOT_MET"` | the test **pins** the defect, so a fix fails it loudly; see §4 |
| **IPY-15** | **FAIL** | `vitest … -t IPY-15` → 1 passed (transport + both-direction refusal). Supplementary gate: kernel-usable **PASSES**; **structured outcome does NOT** (`hasCode:false, hasLimitBytes:false, hasDeclaredLength:false`) | the shipped gate asserts only a prose substring; the structured clause was measured and failed |
| **BR-07** | **PASS** | `vitest run src/r5-product-bridge.test.ts` → 24/24, 8 of them the BR-07 disposition block | removed the `report(...)` call → the oracle's own stimulus arm went red (1 failed / 6 passed) |
| **DATA-09** | **PASS** | `data-plane.test.ts -t "ALL FOUR acquisition stages"` → 1 passed; `data-r6.test.ts` → 38/38 | retagged `native-acquisition` → a stage with no producer → gate red |
| **DATA-11** | **PASS** | `data11-cursor-realm.test.ts` → 32/32 (refused **and** recorded, 6 arms) | neutered `assertRealm` → **7 tests red**, all the cross-store/recording arms |
| **REC-09** | **NOT_CLAIMED** | topology re-derived in this tree; `durability-advanced.test.ts` → 33/33 | injected a production writer of the terminal state `confirmed` → the DECIDING-topology-fact gate went **red** |
| **REC-10** | **NOT_CLAIMED** | guard **deleted** (grep: only the removal-explaining comment survives); no unreachable remnant | same arm; plus R9's own pattern-revert control (`CONTROL-FALSIFICATION.txt`) |
| **CAP-10** | **PASS** | `capacity-v8-probe.test.ts -t CAP-10` → `admitted=2 heldAgainstTarget3=3`; `f5-admission.test.ts` → 20/20 incl. the RE-TRIGGERABLE arm | neutered **two** layers → v1's exact signature `admitted=3 heldAgainstTarget3=4` returned and the gate went red |

**Counts: 7 PASS / 4 FAIL / 2 NOT_CLAIMED / 0 NOT_RUN / 0 BLOCKED_EXTERNAL.**

`verdicts.json` validates **clean** against the project's own `file-result.py`
`validate_verdict` (13 cases, 0 problems), and all **66** evidence entries are
repo-relative under `qualification/results/` with a recomputed sha256.

---

## 2. WHERE ROUND 1'S CLAIMED FIX DOES **NOT** HOLD UP

This is the field that matters, so it comes before the successes.

### 2.1 `ID-05` — round 1 closed every clause EXCEPT the one that was failing

v1's note: *"FAIL on the escape-hatch clause; every other clause PASSES."*
Round 1's `R2-F10F11/FINDINGS.md` §2 is titled **"F10 — one authoritative typecheck"**.
It fixed the clean/mutation/control arms and added `helpers/typecheck.mjs`. **It
records no `as never` sweep and no config-position analysis.** The v2 provenance
says the sweep was *"deliberately deferred to round 2 (D4) because 478 of the 488
occurrences are in test files under concurrent edit"* — but the failing occurrence is
in **non-test** source:

```
packages/dsh-daily-work/src/durability-runner.ts:37
  await ctx.plugin(Storage, {} as never)          <-- CONFIG POSITION, idiom (b)
```

Decided by experiment, not by reading:

| experiment | result |
|---|---|
| `ctx.plugin(Storage, {} as never)` → `ctx.plugin(Storage)` (omit the arg) | **EXIT 0** — the cast was pure noise here |
| `ctx.plugin(Storage, {})` (drop the cast, keep the arg) | **EXIT 2** — `error TS2345: Argument of type '{}' is not assignable to parameter of type 'undefined'` |

That diagnostic is **verbatim the one the v2 oracle names**. The cast MASKS it, and
the oracle says *"A config-position `as never` is NOT PASS."* The other 8 non-test
casts are noise (removing them compiles clean), and `as any` is 0 real.

### 2.2 `IPY-15` — round 1 was not recorded as having addressed it, and the rewritten half is unmet

The round-2 brief §2 does **not** list IPY-15 among what round 1 closed. The v2
provenance records the rewrite (authority D2): *"v2 keeps fail-hard and requires a
structured refusal that names the limit."* The product's half was already fail-hard;
the **structured** half was never added:

```
[S4-MEASURED] IPY-15-structure
  encode: {name:"FrameError", ownEnumerableKeys:["name"], hasCode:false, hasLimitBytes:false, hasDeclaredLength:false}
  decode: {name:"FrameError", ownEnumerableKeys:["name"], hasCode:false, hasLimitBytes:false, hasDeclaredLength:false}
  numbersAreInFieldsNotMessage: false
```

The limit and the declared length exist **only inside a prose message**
(`protocol.ts:44` `constructor(message: string)` and nothing else). The shipped gate
asserts only that the message **contains the substring `"exceeds"`** — a weaker oracle
than the case it is filed under (G-FIX-04). *The kernel-usable clause, which the
shipped gate never measured at all, DOES pass* (`kernelStillUsable:true`,
`epochUnchanged:true`).

### 2.3 `IPY-13` — round 1 wrote the experiment and did not implement it

`R8-ipy13-experiment/EXPERIMENT.md` is a good isolated experiment, and round 1
**did not implement it**: `grep -c metadata packages/dsh-ipython/src/broker.py` → **0**.
So the broker does not attach a DSH cell id to `execute_request.metadata` and there is
no kernel-side `ContextVar` hook. Measured in this tree: **clause 1 passes, clause 2
fails** — the straddling write is silently attributed to the later cell. This is a
verdict about `fef7612`; **S5 is implementing it now**, so it must be re-run after S5
merges.

### 2.4 `ID-06` — the fix did not happen; only the entry count fell

Round 1 moved the two untracked directories out and recorded that *"`ID-06` remains
FAIL, and must."* That is correct and honest. The remaining entry is an EOL/stat
artifact, proven by four measurements (identical blob id, empty `--numstat`, a
control repo reproducing the same signature, and the file being the **only** CRLF file
in a 400-file tracked sample). **The oracle is unconditional, so it is FAIL** — see §3.

### 2.5 What DID hold up, stated plainly

`ID-01` (F4 deep import gone, reproduced by falsification), `CMP-02`/`CMP-04` (F3
sandbox row + the v2 rewrite), `BR-07` (F2/BridgeServer disposition vocabulary now
present on the bridge route), `DATA-09` (F7 taxonomy split), `DATA-11` (F6 cursor
realm), `CAP-10` (F5 admission), `REC-09`/`REC-10` (F8 deletion + non-claim). Round 1's
claims for these all held up under independent measurement, and R9's own falsification
record of its first revision is a genuine instrument correction.

---

## 3. THE CASES THAT ARE NOT "13 RED LIGHTS"

Three of the thirteen are **qualification's own modelling errors**, and the honest
action was to judge the oracle as written rather than to manufacture a producer.

- **`ID-06` is FAIL by the oracle's own unconditional text, and I did not invent a
  carve-out.** I tried to clear it: `git update-index --refresh` on a **copy** of the
  index still prints `needs update` and still reports ` M`; `git add` against a
  temp index built from HEAD produces blob `c05787d9…`, **identical to HEAD**, with an
  empty `diff --cached --numstat`. There is no content delta to stage. The real index
  was verified byte-identical before and after every probe. A PASS requires a change to
  the **qualification environment** (`core.autocrlf=false` checkout, or
  `git add --renormalize` on that path), which rewrites a tree this writer does not own.
- **`CMP-04` is PASS and was not obtained by editing an oracle.** v1's FAIL was a
  genuine spec defect (it pinned `28` and required `pwsh` present, contradicting
  CMP-13). v2 rewrote it; I edited neither. My control arm independently reproduces the
  arithmetic: **pwsh present ⇒ 28, absent ⇒ 27.**
- **`REC-09`/`REC-10` are NOT_CLAIMED, which is not PASS.** The v2 stimulus explicitly
  permits *"state the topology fact that makes it impossible instead of constructing
  one."* The fact is re-derived here (no non-test call site targets a terminal state;
  the one in-flight state the product writes has no reachable exit), it is **falsifiable**
  (injecting a terminal-state writer turns the gate red), and the guard is **deleted**
  rather than left unreachable.

---

## 4. PRODUCT REACHABILITY

Every PASS names the path that reaches it, because "a test mounts it" proves nothing
about the product.

- **ID-01, CMP-02, CMP-04** — a **real built launcher** boot of the composed daily
  profile, on a harness-chosen free port, from a foreign cwd, with the profile's
  `link:` targets asserted to resolve at **this** worktree. `--no-open`, keyless mock
  route, no provider budget consumed.
- **CAP-10, DATA-09, DATA-11, BR-07, REC-09/REC-10** — driven through the **service's
  own public API** (`WorkService.drain` / `tryReserveAdmission` / `ArtifactStore` /
  the bridge's lease close), not through a private handle.
- **IPY-13, IPY-15** — a **real `KernelHost`** spawning the real broker and a real
  IPython kernel (`ipython 9.16.1`, `ipykernel 7.3.0`).

**NOT CLAIMED:** that any of this reaches a *live model turn*. `compatibility.lock.json`
carries `live_provider_budget_authorized: false`, so every run here is a **controlled
local route**. `BR-07` in particular does **not** claim the bridge is reached by a real
daily boot — `V4-bridge/GATES.md` §1 records a separate reachability FAIL (G-SEAM-34)
that a reader must carry alongside that PASS.

---

## 5. INSTRUMENT DISCIPLINE — the traps I hit, recorded because they produced wrong readings

1. **The profile's `link:` targets pointed at the MAIN checkout.** My ID-01 driver
   re-copies the repository profile, which **restored** `link:D:/DSH/work/dsh-native-daily/…`
   and undid the provisioner's rewrite. First run measured the **main checkout** — whose
   built `lib/artifacts.js` still has the F4 deep import at line 73 — and reported FAIL.
   That is G-SEAM-29/36 produced by my own file copy. The driver now reproduces and
   **asserts** the rewrite, and exits 3 if the links do not point at this worktree.
2. **A `/src/` substring classifier is wrong here.** The checkout is `D:\DSH\src\dsh-src`,
   so every path inside it contains a `src` segment. My first classifier produced three
   false FAILs. Fixed by copying v1's classifier verbatim (SOURCE only on a `.ts`
   extension; BUILT on `lib/*.js|mjs|cjs` at **any** depth).
3. **Falsifying CAP-10 took two layers.** Neutering the target check alone did **not**
   restore the overshoot — the `mayAdmit` pre-check refused instead. Only neutering
   **both** reproduced v1's signature. A one-layer falsification would have been reported
   as "the control does not work", which would have been wrong.
4. **A control can pass vacuously.** My first CMP negative arm disabled `sandbox-policy`,
   which made the whole preset fail to mount — so `pwsh absent` "passed" on an **empty**
   catalog. That is why the second, narrow arm exists.
5. **My own attribution probe had a bug.** It read `reason` off a `LaunchOutcome` and
   printed `'none'` for a *refused* call; `'none'` is the **success** reason on the
   different `AdmissionReservation` type. The raw reading was wrong and is recorded in
   `raw/cap-evidence.txt` §5 rather than deleted.
6. **The v2 definition carries no status fields, and I added none.** Its own
   `definition_forbids` list is `[status, evidence, verdict, note, result, identity]`;
   results live under `qualification/results/<qualification-contract-id>/`. The
   definition file's digest is **unchanged** and re-verified (`115aa092…`).

---

## 6. IDENTITY

Computed with `qualification/runners/qualification-identity.py` against this worktree:

```
qualification_contract_identity   ea50307307130900d48fa867fa45d9d2b8a1978f73f0efb16bcc1c89520164df
runtime_deployment_identity       1a900e389a5d9622d7c0dd248892ec6625c36141c16268bf542eca82f9133c22
acceptance_definition_digest      115aa092d0279c005d6f83d0412c1e00d374b60f803dd10f56eaba878ed664e1  (UNCHANGED)
```

These differ from the archived `trusted-local-v2.88834ae45ad7` values **by design**:
`implementation_commit` is a runtime-identity input, and this tree is **88 commits
ahead** of the archived `fe3ef72a`. The v2 identity's own `staleness` note says so:
*"a result filed before the FINAL integration commit is stale by construction, and the
root agent re-derives at integration."* The **acceptance definition digest is
unchanged**, so these verdicts are bound to the same 110-case definition — and to
`fef7612`, not to `88834ae4`.

---

## 7. UNRESOLVED UNKNOWNS

1. **The verdicts that WILL change once a sibling merges.** Four cases are measured
   against a tree that is being actively changed:
   - **`IPY-13`** — S5 is implementing the `execute_request.metadata` → `ContextVar`
     mechanism **now**. Clause 2 will move from FAIL toward PASS (or the pin will move).
     **Re-run `vitest … -t IPY-13` and the clause-2 measurement after S5 merges.**
   - **`IPY-15`** — S6 is working on the transport/frame cases. If the structured
     refusal fields are added, the clause measured here as unmet will change.
     **Re-run `vitest … -t IPY-15` plus the supplementary gate.**
   - **`ID-05`** — S7 is working on it. The `durability-runner.ts:37` config-position
     cast is the single blocking occurrence; **re-run the two-arm experiment** after S7
     merges. (The ID-05 sweep is also the one place where 349 real `as never` casts
     remain in **test** source, deliberately out of scope.)
   - **`ID-01`, `CMP-02`, `CMP-04`, `BR-07`, `DATA-09`, `DATA-11`, `CAP-10`** — these
     PASS against `fef7612`. A sibling merge that touches the same files
     (`host.ts`, `artifacts.ts`, `bridge.ts`, `observations.ts`, the profile patch)
     invalidates them; the instruments are in `S4-v2-rejudge/probe/` and are re-runnable.
2. **`ID-06` cannot PASS without a decision this writer cannot take.** Two remedies are
   named in `raw/id06-evidence.txt` §7; both change the **qualification environment**.
3. **The `unknown`-with-no-exit defect is unfixed and out of scope.** A task left
   `unknown` holds a child slot forever, permanently reducing N by each failed launch,
   and `reconcileRun` has no production caller. R9 reported it; it is recorded here and
   not fixed. **It is also why REC-09/REC-10 are NOT_CLAIMED rather than PASS.**
4. **`DATA-13` (the ProjectionManifest half of the DATA-09 split) is outside this
   slice** and is not judged here. `DATA-09`'s PASS covers the acquisition half only.
5. **Whether the CMP-04 `pwsh absent` clause should ever be a *pass condition*** rather
   than a recorded composition fact is a question for the spec's owner. v2 states the
   current architecture; a future composition change would flip that clause. I did not
   edit it.

---

## 8. CLAIMS I AM NOT MAKING

- **Not** claiming any PASS was established through a **live provider**. All runs are a
  controlled local route; `live_provider_budget_authorized` is `false`.
- **Not** claiming `ID-06`'s FAIL is a product defect. It is a qualification-environment
  EOL artifact, and the qualified artifact's digest is intact — but the oracle is
  unconditional and I did not weaken it.
- **Not** claiming `REC-09`/`REC-10` PASS, or that the system is safe because the
  guarantee is not claimed. NOT_CLAIMED says the deployment makes no claim; it does not
  say the risk is absent.
- **Not** claiming `IPY-15`'s structured clause is satisfied, and **not** claiming the
  shipped IPY-15 gate is an adequate oracle for the v2 case.
- **Not** claiming `ID-05` is fully closed: the clean/mutation/control arms and the one
  official command hold; the escape-hatch clause does not.
- **Not** claiming `BR-07`'s PASS means the bridge is reached by a real daily boot
  (G-SEAM-34 stands).
- **Not** claiming `DATA-09` speaks for `DATA-13`.
- **Not** claiming these 13 verdicts are a filing for the other 97 cases — those remain
  `NOT_RUN` in `trusted-local-v2.88834ae45ad7/verdicts.json`, and this file is a
  **subset** sharing the same schema.
- **Not** claiming the archived identity `88834ae45ad7` describes this tree. It does not;
  see §6.
