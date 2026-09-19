# T7 — which seam does the model's Python use to reach DSH tools?

**Verdict in one line.** The bridge MECHANISM reaches DSH tools through the
native seam (`ctx.tools.execute`) and is measured correct — and the PRODUCT
does not start it, so today a Python cell has no tool access at all. The
forbidden seam (`ctx.terminalController`) is absent everywhere. **Gate verdict:
FAIL**, on the wiring, not on the mechanism.

This directory holds the measurement that separates those two facts.

---

## The two questions, answered separately

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Is the bridge mechanism correct, and does it use the NATIVE seam? | **PASS — MEASURED** | `measurement.json`, `tests.txt` (T7-01…T7-05) |
| 2 | Does the PRODUCT use it? | **FAIL — MEASURED** | `import-graph.txt`, `wiring.json`, `tests.txt` (T7-07) |
| 3 | Does `ctx.terminalController` appear on the model's Python path? | **NO — MEASURED** | `tests.txt` (T7-02, T7-08), `terminalController-scan.txt` |
| 4 | Is there exactly ONE model loop? | **PASS — MEASURED** | `measurement.json` (`oneModelLoop`), `tests.txt` (T7-03) |

Question 1 must not stand in for question 2. That substitution is the
weaker-oracle mistake this project's audit exists to catch, and it is the whole
reason this file states them as two rows rather than one.

---

## 1. The seam: a real cell's `dsh.call` reaches `ctx.tools.execute` — PASS

**What was run.** A REAL ipykernel started through the REAL broker over DSH's
own subprocess seam, with the REAL `ToolRuntime` mounted in the production
composition (`SystemPrompt` + `ToolRuntime`, the same two mounts
`dsh-daily-work/src/data-plane.test.ts` uses). A REAL cell ran
`await dsh.call('probe_echo', {'tag': 'from-the-cell'})`.

**How the seam was observed.** From the REGISTRY side, not from anything the
bridge says about itself: a `tools/pre-execute` listener and a `tools/result`
listener on the live `ctx` recorded every call the pipeline actually saw.

**The measurement** (`measurement.json` → `seam`):

```
cellOutcome:  ok
cellStdout:   CELL_SAW:{"marker":"registry-materialized-value","tag":"from-the-cell"}
pipelineSaw:  [{ name: "probe_echo",
                 callId: "ipython-call-1:bridge:1",
                 rootCallId: "ipython-call-1",
                 parentIsSet: true,
                 agentIsSet: true,
                 arguments: { tag: "from-the-cell" } }]
pipelineResults: ["probe_echo:ipython-call-1:bridge:1"]
```

Read as four separate facts:

1. **The registry received the call.** `pipelineSaw` is non-empty and names
   `probe_echo`. A cell that reached a tool by any other route would leave this
   empty.
2. **It arrived as a SUB-DISPATCH.** `parentIsSet: true`. That is the field
   `native-call.ts` exists to stamp, and it is the field the registry's `ptc`
   collapse reads to distinguish a nested call from a model-direct one. A
   model-direct call has no parent.
3. **The sub-call id is derived from the ENCLOSING call id.**
   `ipython-call-1:bridge:1` — the enclosing id the host minted, plus the
   bridge's own ordinal. A random id would be correlatable to nothing.
4. **The registry's OWN canonical value came back to the cell.**
   `CELL_SAW` carries `marker: "registry-materialized-value"`, which is the
   value the tool body returned and the registry materialized. The cell received
   the value, not a rendered projection of it.

**The negative control.** The same cell body with NO preamble leaves `dsh`
absent, and the cell reports `HAS_DSH:False` and `HAS_TERMINAL:False`
(`tests.txt`, T7-01 second arm). Without this, a cell that reached a tool by
some other means would still have produced a passing first arm.

### The native seam, named from the pinned checkout

`ctx.tools.execute` is `ToolRuntime.execute`
(`packages/core/tools/src/index.ts:1348` in `D:\DSH\src\dsh-src`), whose
signature is `execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>`
and whose body composes
`prepareExecution -> completeScheduledExecution` — i.e. `tools/pre-execute` +
monotonic guards, `tools/execute` wrappers, the tool body, `tools/post-execute`,
`finalizeContent`, and the `tools/result` notification. The bridge calls exactly
that (`native-call.ts:225`: `await ctx.tools.execute(input)`), so a bridged call
traverses the same pipeline a model-direct call does. **Read in source, and
confirmed by the measurement above**: the listeners registered for
`tools/pre-execute` and `tools/result` — two of those very stages — fired for
the bridged call.

---

## 2. The forbidden seam: `ctx.terminalController` is ABSENT — PASS (negative)

The constraint, quoted: **严禁把 `ctx.terminalController` 用作模型 Python 能力**.
It is FORBIDDEN to use `ctx.terminalController` as the model's Python capability.

**The answer is NO, and it is measured three ways.**

1. **No source file in the package names it.** T7-08 walks every non-test `.ts`
   in `packages/dsh-ipython/src/` and asserts none matches `\bterminalController\b`.
   Measured: zero offenders.
2. **No composition in the repository mounts one.** `terminalController-scan.txt`:
   a scan of `packages/` and `profiles/` for the name returns hits ONLY in
   `*.test.ts` files, and every one of those is an assertion that it is ABSENT
   (e.g. `security-denial.test.ts:444`:
   `expect(ctx.get('terminalController' as never)).toBeUndefined()`).
   Production code and profiles: **zero hits**.
3. **The live composition never mounts one, and the cell's namespace has no
   terminal handle.** T7-08 asserts `ctx.get('terminalController')` is
   `undefined` on the mounted context, and — measured inside the real kernel —
   the host's contribution to the kernel's module namespace is exactly `['dsh']`,
   of which zero are terminal-named. The client's whole public surface is
   `['Artifact', 'BridgeError', 'call', 'call_sync', 'tools']`, and
   `CLIENT_HAS_TERMINAL:False`.

**A measurement artefact worth recording, because it nearly became a false
finding.** The first version of the kernel-side arm asserted that NO loaded
module had `terminal` in its name. It failed — and correctly: a real IPython
kernel loads **14** such modules, `IPython.terminal.*` and
`IPython.utils.terminal`. They are IPython's OWN console machinery and predate
this package entirely; they are not a DSH seam, and their presence says nothing
about the constraint. The arm was corrected to measure the HOST's contribution
to the namespace (modules loaded from the host-owned scratch directory) rather
than "any module with terminal in the name". Had the assertion been "fixed" by
loosening the pattern instead, the test would have stopped distinguishing
anything. Both the modules and the reason are recorded in `measurement.json` →
`cellNamespace.IPYTHON_TERMINAL_MODULES`.

---

## 3. Exactly ONE model loop — PASS

**The runtime measurement.** A cell made THREE nested calls in a loop; the
registry recorded three dispatches and three results, and the sub-call ids are
the ONE enclosing id with the bridge's own ordinal:

```
dispatches: ["ipython-call-loop:bridge:1",
             "ipython-call-loop:bridge:2",
             "ipython-call-loop:bridge:3"]
results:    ["probe_echo:ipython-call-loop:bridge:1", ... , ":bridge:3"]
cellStdout: TOTAL:3
```

Three cell-side calls produce exactly three pipeline dispatches. A bridge that
ran a second loop, or that mirrored a call, would produce a count that is not 3;
a second loop would also mint a second ENCLOSING call id, and all three ids
share one.

**The source fact, labelled as a source fact.** T7-03's second arm reads
`bridge.ts` and `native-call.ts` and asserts their import closure has no
turn-taking surface: the only thing either takes from `@deepseek-ai/dsh-llm` is
`ToolCallId` (a branded string constructor — an identity type, not a model
client); there is no `dsh-agent-loop` import, no `.chat(`/`.complete(`/
`.generate(`, no `session.append`, and no `new ToolRuntime(`. So the bridge
composes over the ONE registry it is handed and cannot reach a model. This is a
reading, and it is the reason the runtime count can only ever be one — it is not
a substitute for the count.

---

## 4. The native-call contract — MEASURED

All five arms from `measurement.json` → `nativeCallContract`. Each cell reported
`outcome: ok`, i.e. **every failure mode is a VALUE the program can branch on,
not a kernel fault.**

| Case | What the cell received | Note |
|---|---|---|
| Tool body throws | `CODE:TOOL_FAILED` + `MESSAGE:the tool body failed on purpose`, cell survived | the registry's fallback code for a tool's own throw |
| Unknown tool | `CODE:UNKNOWN_TOOL` | the registry's own code, preserved |
| Denied by a monotonic GUARD | `CODE:TOOL_FAILED` + the policy's own message | **see below — the code is NOT a denial code** |
| Denied by a pre-execute POLICY with `info.code` | `CODE:POLICY_DENIED` + the message | the code IS preserved when the denying seam set one |
| Times out (client `timeout=1.0` vs a 4 s tool) | `CODE:TIMEOUT`, cell survived, kernel still usable | `hostReceivedTheCall: true` |
| Value above the inline bound | `TYPE:Artifact`, `VERIFY:True`, `LEN:2097152` | bytes hashed to the host's reported digest |

### A precision the first draft got wrong, and the measurement corrected

The guard-denial arm does NOT return a denial code. It returns `TOOL_FAILED`,
because a monotonic guard denies by returning a reason STRING and the registry
therefore sets no `info`. `native-call.ts:265` reads
`result.error.info?.code ?? 'TOOL_FAILED'`, so the code is only as specific as
the denying seam made it. The first draft of this file claimed a "structured
refusal" without measuring the code; the contrast arm (a `pre-execute` denial
that DOES set `info.code`) was added so the two cases are distinguished rather
than averaged. **The message always survives** — that is the property the
bridge's `error.message` field exists for, and it holds in both cases.

### A defect found and fixed: the timeout contract was broken

`bridge.ts`'s `PYTHON_CLIENT_SOURCE` docstring promises "Errors arrive as
`BridgeError` with a stable `code`". **Measured, the async path did not.**
`_Channel.call_async` used `asyncio.wait_for` with no handler for
`asyncio.TimeoutError`, so a client timeout leaked a bare `TimeoutError`:

```
BEFORE (measured):  EXC_TYPE:TimeoutError
                    EXC_MRO:TimeoutError,OSError,Exception,BaseException,object
                    IS_BRIDGE_ERROR:False      HAS_CODE:False
AFTER:              EXC_TYPE:BridgeError
                    EXC_MRO:BridgeError,RuntimeError,Exception,...
                    IS_BRIDGE_ERROR:True       HAS_CODE:True
```

`call_sync` (line 957) raised `BridgeError("TIMEOUT", ...)` correctly, so the
two paths disagreed about the same condition — a program branching on
`except BridgeError` would have crashed on the async path while working on the
sync one. Fixed in `bridge.ts` by converting the `asyncio.TimeoutError` into the
documented `BridgeError`. The fix is one `except` clause; the assertion that
pins it is the `CODE:TIMEOUT` arm, which fails without it.

**A note on how that fix landed, because it affects where a reader should look.**
The edit was made by this gate and was then swept into ANOTHER agent's commit
(`7bd6864`, "commit the bundle patches and the exports they load by subpath"),
because that agent ran a repo-wide `git commit -a` while the file was dirty.
The content in `HEAD` is byte-identical to what this gate wrote — verified with
`git show 7bd6864:packages/dsh-ipython/src/bridge.ts` — so the fix is not lost,
but its authorship in the log is misleading. This gate's own commit therefore
carries no diff for `bridge.ts`. Recorded rather than left for someone to
discover from an empty `git log -p`.

---

## 5. Does the PRODUCT use the bridge? — NO. THIS IS THE FAIL.

**Two independent instruments, two different methods, same answer.**

**Instrument A — regex import scan** (`wiring.json`, produced by
`probe-wiring.mjs` in this directory). It partitions every hit into ENTRY /
PROBE / TEST so a probe cannot be mistaken for a caller, and emits the verdict
as a single boolean:

```
verdict.bridgeIsStartedInProduction: false

verdict.productionCallSites:
  createNativeCallHandler: ["packages/dsh-ipython/src/native-call.ts"]
  new BridgeServer:        []
  mintLease:               ["packages/dsh-ipython/src/bridge.ts"]   <- its own definition
  renderBridgePreamble:    ["packages/dsh-ipython/src/bridge.ts"]   <- its own definition

verdict.productionImportersOfBridge:      ["packages/dsh-ipython/src/native-call.ts"]
verdict.productionImportersOfNativeCall:  []
```

`new BridgeServer` — the constructor, the one call that would START a bridge —
has **zero production call sites**. The only other files naming any bridge
symbol are the two bridge modules themselves (their own definitions), this
gate's test file, and this gate's measurement driver (`t7-measure.ts`, classed as
PROBE).

**Instrument B — compiler-based entry-closure walk**
(`qualification/runners/import-graph.mjs`, the shared runner, promoted by the
root agent and re-run here; output in `import-graph.txt`):

```
EXPORT ROOTS: ./host ./tool ./kernel ./plugin ./protocol
REACHABLE non-test modules: 5
UNREACHABLE non-test modules: 2
  src/bridge.ts        non-test importers: src/native-call.ts
  src/native-call.ts   non-test importers: (NONE)
TOTAL src modules: 16   non-test: 7   REACHABLE: 5   UNREACHABLE: 2
```

`bridge.ts`'s only non-test importer is `native-call.ts`, and `native-call.ts`
has no non-test importer at all. So both modules are outside the transitive
closure of every entry point the package declares, and the ONLY thing that
imports either is `bridge-seam.test.ts`.

**Why this is a FAIL and not a defect in the bridge.** The mechanism is
correct (section 1). Nothing in the product constructs a `BridgeServer`, so on
the composed profile no bridge is ever started, and a Python cell has no path to
a DSH tool through it. This is the defect class `docs/GAPS.md` records as
"mechanism implemented, tested, correct — while nothing in the product calls
it": the same shape as `setLaunchPort` (G-SEAM-20), `takeContinuation`, the
epoch guard (G-SEAM-21), and `createRun`.

**The combined statement, which is more useful than either half.** The forbidden
path is absent (section 2) AND the sanctioned path is unwired (this section), so
**today the model's Python has no tool access at all.** That matters more than
either half alone, because the composed profile measured 27 tools with `ipython`
present and `pwsh`/`bash` absent
(`qualification/results/M12-deliverable-surface/surface-fresh-install.json`):
`ipython` is the model's ONLY execution surface, and it cannot reach the tools.

**What is NOT claimed.** This is not "the bridge is broken". It is not a claim
about any file outside `packages/` and `profiles/` — the second arm of T7-07
walks those two trees to a capped depth, which is where a composition would live
on this deployment, and says so in its own comment.

---

## The gate table

| Gate | Claim | Verdict | Basis |
|---|---|---|---|
| T7-01 | A cell's `dsh.call` reaches `ctx.tools.execute`, and the value returns | **PASS** | MEASURED — `measurement.json` `seam` |
| T7-01b | Without the bridge the cell has no `dsh` and no terminal | **PASS** | MEASURED — negative control |
| T7-02 | A mounted `terminalController` is never touched on the Python path | **PASS** | MEASURED — decoy with a proven-alive detector |
| T7-03 | Exactly one model loop; N calls = N dispatches, one enclosing id | **PASS** | MEASURED — `oneModelLoop` |
| T7-03b | The bridge has no turn-taking surface | **PASS** | READ IN SOURCE (labelled) |
| T7-04a | A throwing tool → `BridgeError(TOOL_FAILED)`, cell survives | **PASS** | MEASURED |
| T7-04b | An unknown tool → `UNKNOWN_TOOL` | **PASS** | MEASURED |
| T7-04c | A guard denial → structured refusal, policy's message preserved | **PASS** | MEASURED — code is `TOOL_FAILED`, recorded not assumed |
| T7-04d | A policy denial with `info.code` → that code preserved | **PASS** | MEASURED |
| T7-04e | A timeout → `BridgeError(TIMEOUT)`, kernel still usable | **PASS** | MEASURED — **after fixing a real defect** |
| T7-04f | An oversized value → `Artifact` whose bytes verify | **PASS** | MEASURED |
| T7-05a | A forged-authority frame → `FORGED_AUTHORITY`, never dispatched | **PASS** | MEASURED |
| T7-05b | The same frame without the forgery IS served | **PASS** | MEASURED — positive control |
| T7-06 | `terminalController` appears nowhere on the model's Python path | **PASS** | MEASURED — three ways, negative |
| T7-07 | The PRODUCT starts the bridge | **FAIL** | MEASURED — two independent instruments |
| T7-08 | The composed profile's model surface reaches tools through `ipython` | **FAIL** | follows from T7-07; `ipython` is the only execution surface |

**Net: FAIL.** The mechanism is correct and the constraint is honoured; the
product does not wire the mechanism, so the model's Python cannot reach DSH
tools.

---

## What a fix requires (stated, not attempted here)

Wiring the bridge is a change to the composition, not to the bridge: a host-plane
row must construct a `BridgeServer` per kernel, and the cell dispatch path must
mint a lease and prepend the preamble around each `runCell`. `KernelService` is
the natural owner (it already holds the per-Session kernel map and is the only
thing that knows a cell is about to run), but it currently has no `BridgeServer`
and no dependency on one. Two integration questions are NOT answered by this
gate and would need their own measurement:

1. **Where the preamble is prepended.** `canPrependPreamble` exists and refuses
   a `%%` cell magic; whether `runCell` or the broker is the right place is a
   design decision with a real failure mode either way (a preamble prepended in
   the wrong layer would not survive the broker's own framing).
2. **Lease lifetime against the cell timeout.** `DEFAULT_CALL_TIMEOUT_MS` is
   120 s and `DEFAULT_CELL_TIMEOUT_MS` is also 120 s, so a nested call that
   consumes the whole cell budget leaves no room for the cell to report it. The
   measured `TIMEOUT` arm used an explicit 1 s client timeout to avoid that
   overlap; the defaults as shipped have not been measured together.

---

## Files in this directory

| File | What it is |
|---|---|
| `FINDINGS.md` | this file |
| `measurement.json` | the RAW measurement — every value cited above, as JSON |
| `measurement.err` | its stderr (empty is the honest rendering of "clean") |
| `tests.txt` | the real `vitest` output for `src/bridge-seam.test.ts`, 17/17 |
| `wiring.json` | instrument A: the regex import/symbol scan |
| `probe-wiring.mjs` | instrument A's source |
| `import-graph.txt` | instrument B: the shared entry-closure walk |
| `terminalController-scan.txt` | the repository-wide negative scan for the forbidden seam |
| `tsc.txt` | the typecheck, exit 0 |

The tests live at `packages/dsh-ipython/src/bridge-seam.test.ts` (17 tests) and
the measurement driver at `packages/dsh-ipython/src/t7-measure.ts`.
