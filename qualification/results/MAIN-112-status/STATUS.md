# The 112 acceptance gates — measured status

> **This file is the authoritative status of the new 112-case spec. It is NOT a
> PASS list.** 92 of the 112 cases have at least one evidence file that names them
> by id; the remaining 20 are named here with the reason. The promotion decision
> is unchanged: `NOT_READY`.

## Why this file exists

`qualification/specs/acceptance-spec.json` records **all 112 cases as `NOT_RUN`
with empty `evidence`**, and it has never been updated. Meanwhile the milestone
directories under `qualification/results/` hold real, measured evidence for most
of them. Two different id spaces coexist:

| Artifact | Cases | Id scheme | State |
|---|---|---|---|
| `qualification/gates.json` | 104 | `A01…J03` | Regenerated; 85 PASS / 2 FAIL / 10 NOT_RUN / 1 BLOCKED_EXTERNAL / 6 NOT_APPLICABLE. All **127** evidence digests verified against disk. |
| `qualification/specs/acceptance-spec.json` | 112 | `DEP-01…UPG-08` | **Never regenerated.** All `NOT_RUN`, all `evidence: []`. |

The two id spaces are **disjoint** — no case id is shared (recorded in
`qualification/results/M10-shrink/FINDINGS.md` §4). So a reader who opens the
spec sees "nothing has been run", and a reader who opens `gates.json` sees 85
PASSes, and neither is a statement about the other.

**This file closes that gap by mapping the new ids to the evidence that exists,
and by naming the cases where no evidence exists.** It does not modify either
machine-readable file; regenerating the spec is a separate decision because the
spec is an input to the deployment identity.

## Method, and its limit

For each of the 112 cases, every file under `qualification/results/**` was
searched for a literal occurrence of the case id. 92 cases are named by at least
one evidence file. That is a **mechanical** mapping: it proves a file mentions the
id, not that the file establishes the oracle. The per-family sections below state
which claims were verified by reading the assertion and which rest on the
milestone's own FINDINGS.

**Where a case is named only inside a "what is NOT proven" list, it is counted as
NOT established.** Several are — the search finds the id wherever it appears.

## Coverage by family

| Family | Named by evidence | Cases | Gap |
|---|---|---|---|
| DEP | 8 | 8 | — |
| BRG | 8 | 8 | — |
| DAT | 8 | 8 | — |
| WEB | 8 | 8 | — |
| HIS | 8 | 8 | — |
| SEC | 8 | 8 | — |
| VER | 8 | 8 | — |
| ECO | 8 | 8 | — |
| UPG | 8 | 8 | — |
| CAP | 7 | 8 | CAP-01 |
| RES | 5 | 8 | RES-01, RES-05, RES-06, RES-07, RES-08 |
| UI | 4 | 8 | UI-02, UI-03, UI-05, UI-06, UI-07, UI-08 |
| IPY | 3 | 8 | IPY-01, IPY-02, IPY-03, IPY-04, IPY-05, IPY-06 |
| REC | 1 | 8 | REC-01, REC-02, REC-03, REC-04, REC-05, REC-06, REC-07 |

**The IPY gap is a numbering gap, not a coverage gap.** `packages/dsh-ipython`
has a 12-requirement table in `qualification/results/M11-ipython/FINDINGS.md`
(lines 24–35) that covers the same ground under different labels, and 54 tests.
The mapping is direct and is stated below. A reader should treat IPY-01..08 as
**evidenced under the M11 numbering**, not as unrun.

**The REC gap is real and the largest.** Only REC-08 is named anywhere. The
milestones that cover this ground (`M4.1-process-kill`, `M9.4-durability-advanced`,
`M9.15-durability-records`, `M5-lifecycle`) use the OLD `D01…D14` numbering, so
their evidence exists but is not addressable by the new ids. Establishing REC-01..07
requires either re-labelling that evidence or running the cases under the new ids.

## Per-family status

### IPY — 10 of 12 requirements PASS, 2 PARTIAL (mapped from the M11 numbering)

| New id | M11 # | Status | Basis |
|---|---|---|---|
| IPY-01 真实IPython | 1 | **PASS** | A real `ipykernel` shell, not a CPython fake. 2 tests. |
| IPY-02 持续变量 | 3 | **PASS** | Namespace persists across cells; a value assigned in cell 1 is read in cell 2. 2 tests. |
| IPY-03 top-level await | 4 | **PASS** | Top-level await with no async-function wrapper. 3 tests. |
| IPY-04 异常部分状态 | 5 | **PASS** | An exception does not roll back the namespace. 2 tests. |
| IPY-05 禁stdin | 6 | **PASS** | stdin disabled, fails fast, does not hold the cell. 2 tests. |
| IPY-06 结果匹配 | 7 | **PASS** | Only the matching reply+idle completes a cell; a foreign frame cannot end it. 2 tests. |
| IPY-07 取消后复用 | 8 | **PARTIAL — the honest boundary** | A CPU loop settles ~1.8 s after interrupt. An **`await`-suspended cell does NOT settle**: 20.15 s, then 10.07 s more on a second interrupt, kernel alive. Implemented as `unknown` + reset + epoch advance, which is the requirement's own escape hatch. **This is not a graceful `KeyboardInterrupt` and is not claimed as one.** Only one interrupt route works on Windows at all: the control-channel `interrupt_request` logs `Interrupt message not supported on Windows`; the Win32 interrupt event is the working route. |
| IPY-08 自然activation结束 | — | **NOT ESTABLISHED** | Needs a real continuable-child activation end, which needs a model provider. `BLOCKED_EXTERNAL`. |
| (M11 #2 transport) | 2 | **PASS** | CurveZMQ over TCP; IPC is impossible on Windows (`Protocol not supported`). **CurveZMQ is an authorisation boundary, not only encryption**: a client with the ports AND the HMAC key but no curve keys gets `Kernel died before replying to kernel_info`. So M0's plaintext exposure was a capability leak and is closed. |
| (M11 #9 late output) | 9 | **PARTIAL — corrected downward** | The kernel stamps a background write with the MOST RECENT parent (`iostream.py:600-607` — the contextvar falls back to a global, and a `threading.Thread` starts with an empty context). Output after idle IS classified late and never rides the next cell. **A write landing during a LATER cell is genuinely undecidable** without a second IOPub channel, which the audit forbids. `TRANSPORT-FINDINGS.md` previously claimed the originating cell's parent id is preserved; that claim was wrong and has been corrected. |
| (M11 #10 bounded output) | 10 | **PASS** | Output is bounded. |
| (M11 #11 kernel death) | 11 | **PASS** | Kernel death changes the generation (epoch advances, loss reported). |
| (M11 #12 one tool) | 12 | **PASS** | ONE tool named `ipython` with ONE parameter `code`. Measured in a real boot: `qualification/results/M12-deliverable-surface/surface.json`. |

### CAP — 7 named, CAP-01 named only in a limitation

`qualification/results/M12-capacity/` covers the family with a host-wide child
slot ledger. **Verified by reading the assertion, not the note:** CAP-07's test
mounts TWO real roots with the runtime configured for `maxActiveSubagents: 64`,
so a refusal can only come from the host-wide ledger. It asserts root B's second
child is refused with `/hard capacity is 3/`, that root A is refused too, that
`gate.occupied` stays 3, and that neither refused child exists in the registry.

- **CAP-01 (硬30并发)** is named in `M12-capacity/FINDINGS.md` but as part of the
  **limitation** discussion: `maxActiveSubagents` in the pinned checkout is
  **per-root, not host-wide** (`continuation-activation.ts:180` —
  `rootPools = new WeakMap<Agent, ActivationPool>()`), and a one-shot
  `ctx.subagents.start()` performs **no capacity check at all**. This project's
  ledger is what makes the cap host-wide. So CAP-01 is **satisfied by this
  project's guard, not by the deployment constant** — a distinction that matters,
  because raising the config value does not bound the host.
- **CAP-06 (无空任务)** is verified: a ready-shortage at target 30 with only 2
  real children creates exactly 2 children and reports the shortage, proving no
  filler agents are spawned.

### RES — 5 named; RES-01/05/06/07/08 not addressable by id

`qualification/results/M11-ipython/FINDINGS.md` names RES-04 and reports the
CPU-loop measurement and the C-extension escalation. The remaining five are not
named anywhere by their new ids. Their subject matter (control priority, output
flood, background late output, kernel RSS/process budgets, park resources,
native data backpressure, fair native calls) is partly covered by
`M9.2-terminal-advanced` and `M11-ipython` under other labels, and
`kernel-lifecycle.ts` implements the budgets (`recordNestedCall`,
`recordDataBytes`, `rssBytes`, `processCount`) with tests in
`kernel-recovery.test.ts`. **But a budget that is implemented and tested is not
the same as a budget reached through the product**, and `kernel-lifecycle.ts`'s
reachability is under separate investigation. Recorded as **NOT ESTABLISHED
under these ids.**

### UI — 4 named

`M12-capacity/FINDINGS.md` and `target-setting.test.ts` cover the N control:
a real `installSection` seam with `applies: 'live'`, live read with no restart,
persistence and reconnect, revision read, and **14 illegal values refused at the
host** (`0`, `31`, `1000`, `2.5`, `NaN`, `Infinity`, `-1`, `'12'`, `'twelve'`,
`null`, an object, an array, a boolean, a function) with boundaries `1` and `30`
accepted. That establishes UI-02 and UI-04 substantively even though only
UI-01 and UI-04 are named by id.

- **UI-03 (revision 竞态)**, **UI-05 (准确状态)**, **UI-06 (kernel状态)**,
  **UI-07 (artifact查看)**, **UI-08 (单续行owner)** are **NOT ESTABLISHED by
  id.** UI-08's subject — that exactly one owner drives a root's continuation —
  is addressed by the `takeContinuation` fix (`982e82b`) and by
  `M8.4-goal-handover`, but under those labels, not this id.
- **UI-01/05/06/07 require a real UI.** No UI has been built or qualified; the
  Web host is qualified only to the credential boundary (gate A12). A UI case
  cannot be PASS on backend evidence alone.

### REC — 1 of 8 named, and it is the largest real gap

| New id | Status | Note |
|---|---|---|
| REC-01 对象先事件后 | **NOT ESTABLISHED by id** | Covered in substance by `M4-data`'s crash-consistency arm (a real SIGKILL between publication and the Session reference leaves a reconcilable ORPHAN, never reported as delivered). Under `D`-numbering. |
| REC-02 坏引用 | **NOT ESTABLISHED by id** | — |
| REC-03 未接纳启动 | **NOT ESTABLISHED by id** | — |
| REC-04 effect回包丢失 | **NOT ESTABLISHED by id** | The `unknown` semantics exist (`M9.5-effects`) but under other labels. |
| REC-05 kernel死亡 | **NOT ESTABLISHED by id** | The mechanism IS built: `kernel-lifecycle.ts` advances the epoch and publishes a `lostOnRestart` list, and `kernel-recovery.test.ts` tests it. Not addressable by this id. |
| REC-06 checkpoint落后 | **NOT ESTABLISHED by id** | `validateCheckpoint` + `RECOVERY_SCOPE_STATEMENT` exist with tests. Not addressable by this id. |
| REC-07 反序列化攻击 | **NOT ESTABLISHED by id** | `REFUSED_FORMATS` exists. Not addressable by this id. |
| REC-08 断线重连 | **named** | `P1-suite-triage/iso-kernel-recovery-rerun.txt` names it in a failing-test list, i.e. **not as established evidence**. |

**The honest summary for REC: the mechanisms exist and are unit-tested, but no
case in this family has evidence addressable by its new id, and three of the
eight (REC-02, REC-03, REC-04) have no obviously corresponding milestone at all.**
Re-labelling the existing evidence would move REC-01/05/06/07/08 to a defensible
"evidenced under D-numbering" state; REC-02/03/04 would need actual runs.

## The cases with no evidence file naming them (20)

```
IPY-01 IPY-02 IPY-03 IPY-04 IPY-05 IPY-06 IPY-08   (7 — a numbering gap; see above)
REC-01 REC-02 REC-03 REC-04 REC-05 REC-06 REC-07   (7 — a real gap; see above)
RES-01 RES-05 RES-06 RES-07 RES-08                 (5 — not addressable by id)
UI-02 UI-03 UI-05 UI-06 UI-07 UI-08                 (6 — partly a numbering gap, partly a real UI gap)
CAP-01                                             (1 — satisfied by this project's guard, not the deployment constant)
```

## What this file does NOT claim

- It does **not** claim 92 cases are PASS. It claims 92 are **named** by some
  evidence file. Where a case is named only inside a limitation list, that is
  stated.
- It does **not** update `acceptance-spec.json`. The spec remains all-`NOT_RUN`,
  which is why the promotion decision is `NOT_READY` and stays so.
- It does **not** claim the REC family is unbuilt. The mechanisms exist; what is
  missing is evidence **addressable by the new ids**, plus three cases with no
  corresponding milestone.
- The IPY family's two PARTIALs are PARTIAL. A requirement met by its own escape
  hatch (`unknown` + reset) is not a requirement met gracefully, and the
  distinction is stated in the table rather than smoothed.

## Evidence digests

Every one of the **127** evidence references in `qualification/gates.json` was
re-hashed against disk: **127 match, 0 stale, 0 missing.** An earlier audit
(`M10-shrink` §4) recorded 3 stale references (T05/T06/T08); those files have
since been extended and the digests regenerated, so the drift is closed. That is
the state at the time of writing, and it is a fact about the files, not a
promise: any further edit to an evidence file makes the corresponding digest
stale again, which is the mechanism working.
