# The external-blocker register, and the readiness statement

**Slice:** C12. **Tree:** `D:\DSH\work\wt-c12`, branch `wt/c12`, HEAD `93f88ba`
(`integrate: P13's plane test opts into the memory ledger explicitly, at all 3 sites`).
Working tree clean except this writer's own untracked `.writer-provision.json`.
**Date:** 2026-09-20. **Author:** writer c12. **Type:** documentation and verification only.

This document did **not** change any code, any verdict, any spec, or any lock. It ran no test
suite, no network operation, no install, no paid API call, and no budget-consuming run. Every
number below is either a command's verbatim output or is quoted from a named file, and every
command is given so a reader can re-run it.

**The one-line honest summary.** This tree has exactly **one** case the release gate sanctions as
`BLOCKED_EXTERNAL` (`IPY-08`), and it has **thirteen** mandatory `FAIL`s, **three** stale evidence
digests, and **314** evidence entries stamped with a superseded identity. The gate's verdict is
`NOT_READY` with **four** named blockers plus a fifth failing check the blocker list does not name.
A further set of requirements is genuinely blocked on things this machine does not have — an
authorized provider budget, a second execution world, a paid-evaluation authorization, a vendor
benchmark. The rest of the `NOT_RUN` population is **unattempted**, which is a different thing, and
conflating the two is the dishonesty this register exists to prevent.

---

## 0. Measurement basis

Every claim in this file traces to one of these. Run from `D:\DSH\work\wt-c12`.

### 0.1 The release gate, verbatim

```
$ python qualification/runners/release-gate.py
RELEASE=NOT_READY blockers=4 candidate=533c8cb08b2ccd7f
candidate   533c8cb08b2ccd7f...
recorded    533c8cb08b2ccd7f...
recomputed  152e5c45c4aef97b...
  BLOCKED_EXTERNAL=1, FAIL=13, PASS=95

  [FAIL] 1 verify-spec passes
          317 problem(s)
  [FAIL] 2 identity is fresh
          lock records 533c8cb08b2ccd7f... but the tree recomputes 152e5c45c4aef97b... -- the evidence describes a different artifact
  [FAIL] 3 no FAIL
          13: ID-01, ID-05, ID-06, CMP-02, CMP-04, IPY-13, IPY-15, BR-07
  [ok  ] 4 no FLAKY (spec status and stability ledger)
          none
  [ok  ] 5 no NOT_RUN among mandatory cases
          none
  [ok  ] 6 no INVALIDATED
          none
  [FAIL] 7 no stale evidence
          3 stale/missing evidence reference(s)
  [ok  ] 8 only allowlisted BLOCKED_EXTERNAL
          none
  [FAIL] 9 post-integration assembled-product evidence at the current identity
          0 of 61 assembled-product PASS case(s) carry evidence stamped with the current identity

release-gate: NOT_READY -- 4 blocker(s):
  - STALE IDENTITY: recorded 533c8cb08b2ccd7f... != recomputed 152e5c45c4aef97b...
  - FAIL: 13 mandatory case(s) failed
  - STALE EVIDENCE: 3 evidence file(s) missing or hash-mismatched
  - NO POST-INTEGRATION ASSEMBLED-PRODUCT EVIDENCE: no T2/T3/T4/T6 case carries a PASS with evidence stamped at the current identity. This is the check that makes 'a gate that is not run post-integration is not a gate' mechanical
EXIT=1
```

**Check 8 reads `[ok]`.** That is the allowlist working, and §2 says exactly how.

### 0.2 The two specs

| Spec | Cases | Status distribution | Command |
|---|---|---|---|
| `qualification/specs/acceptance-spec.trusted-local-v1.json` (the trusted-local spec) | 109 | `PASS=95, FAIL=13, BLOCKED_EXTERNAL=1` | `python -c "import json;from collections import Counter;print(Counter(c['status'] for c in json.load(open('qualification/specs/acceptance-spec.trusted-local-v1.json',encoding='utf-8'))['cases']))"` |
| `qualification/specs/acceptance-spec.json` (the authority spec) | 112 | `NOT_RUN=112` | same, other path |

The authority spec's tiers: `integration 72, fault_injection 16, security 16, evaluation 8`. Its
`target` is `DSH Native Programmable Session` and its `hard_child_capacity` is `30`, `target_range
[1, 30]`.

### 0.3 verify-spec, decomposed

```
$ python qualification/runners/verify-spec.py
VALIDATION=FAIL problems=317 cases=109 identity=533c8cb08b2ccd7f
  BLOCKED_EXTERNAL=1, FAIL=13, PASS=95
```

The 317 problems are **not** 317 independent defects. Decomposed by kind:

| Kind | Count | Meaning |
|---|---|---|
| `evidence was filed under identity 0a0996f3944b5528... but the lock's identity is 533c8cb08b2ccd7f...` | **314** | bookkeeping: every evidence entry was filed before the round-3 identity move |
| `evidence <path> hashes to X... but the case records Y...` | **3** | filing drift: three evidence files were edited after their digests were filed |
| any other kind | **0** | — |

The three stale digests, exactly:

| Case | Evidence file | Recorded | Hashes to |
|---|---|---|---|
| CMP-07 | `qualification/results/V2-composition/boot7-home-override.json` | `6ace8eb92aa62029...` | `688110f3026079d2...` |
| CMP-12 | `qualification/results/V2-composition/boot7-home-override.json` | `6ace8eb92aa62029...` | `688110f3026079d2...` |
| VER-09 | `qualification/results/V9-verification/ver09-tier-audit.json` | `197399316cef7304...` | `56aaddf1df64def5...` |

### 0.4 The identity, and why it moved

```
$ python helpers/rederive-identity.py
recorded identity  : 533c8cb08b2ccd7f94b8e0231ca9ea62918107dc6e8733471d23ca57c8d8a6fb
recomputed identity: 152e5c45c4aef97ba986b917077849173a66585146b67032ec7be64472c39b78
2 input(s) moved:
  host_profile_digest   CHANGED: profiles/daily-candidate/cordis.patch.yml
  agent_preset_digest   CHANGED: profiles/daily-candidate/presets/daily-standard/agent.cordis.yml
```

Both files are byte-identical between this tree's HEAD and the integration branch
`cand-round3` (verified: `git rev-parse HEAD:<path>` equals `git rev-parse
cand-round3:<path>` for both). `cand-round3` records the **recomputed** value as its identity,
because the re-derivation commit (`5b014e9 identity: re-derive for the round-3 integration -- two
inputs moved, both intended`) is one of eight commits on `cand-round3` that this branch point does
not contain. So the `STALE IDENTITY` blocker on this tree is a **missing bookkeeping commit on this
branch**, not a product defect — see §3.3.

### 0.5 Divergence from this task's own brief — read this first

The brief handed to this writer states: *"The release gate currently reports NOT_READY with 1
blocker: 'FAIL: 9 mandatory case(s) failed'"*, and *"`UPG-07` is explicit that mock results do not
substitute"* with the 109-case spec having "exactly 1 BLOCKED_EXTERNAL case".

**On this tree that is not what the gate says.** Measured here: **4 blockers, 13 FAILs**. The
"1 blocker / 9 FAILs" state is real, but it lives on the integration branch `cand-round3`
(`D:\DSH\work\wt-integrate`), which is **8 commits ahead of this branch point** and which has the
round-3 identity adopted. I verified it read-only by exporting that branch to a temp directory and
running its own gate there:

```
$ git archive cand-round3 | tar -x -C /tmp/cr3 && cd /tmp/cr3 && python qualification/runners/release-gate.py
RELEASE=NOT_READY blockers=1 candidate=152e5c45c4aef97b
  BLOCKED_EXTERNAL=1, FAIL=9, PASS=99
  [FAIL] 1 verify-spec passes
          315 problem(s)
  [ok  ] 2 identity is fresh
  [FAIL] 3 no FAIL
          9: ID-01, ID-05, CMP-04, IPY-13, IPY-15, DATA-09, DATA-11, REC-09
  ...
release-gate: NOT_READY -- 1 blocker(s):
  - FAIL: 9 mandatory case(s) failed
```

Both states are reported in this document, each labelled with the tree it came from. **A reader must
not merge them**: a verdict on `cand-round3` is not a verdict on `wt/c12`, and the two trees carry
different identities, different specs and different gate results. The nine-commit difference is
itself a finding — it means the register had to be written against a moving target, and any number
in this document is true of the tree named beside it and no other.

---

## 1. THE REGISTER

### 1.1 What counts as blocked, and what does not

This register uses three categories, and it keeps them apart on purpose:

| Category | Test it must pass to be here | What it is NOT |
|---|---|---|
| **BLOCKED_EXTERNAL** | An artifact this machine does not have is required, **and** that is evidenced by a quoted constraint, a quoted oracle, or a quoted failed attempt. | Not "hard", not "later", not "not yet wired". |
| **UNATTEMPTED** | No verdict exists. Nobody ran it. | Not blocked. There is no evidence it *cannot* run, only that it *has not*. |
| **FAIL / DEFECT** | A verdict exists and it is negative. | Not blocked. The thing was run and it did not hold. |

**The rule this document is built on:** an unattempted case presented as blocked, or a mock
presented as a real result, are the two ways this register could lie. Where the product can only
establish something through a mock or a control route, that route is labelled `[MOCK]` or
`[CONTROL]` in place, and the label is never dropped.

### 1.2 The register at a glance

| # | Blocked item | Spec / id | Externally missing | Evidenced by | Category |
|---|---|---|---|---|---|
| B-01 | A natural activation end rebinds the kernel or reports epoch loss explicitly | trusted-local v1 / `IPY-08` (T5) | An authorized live provider driving a real continuation | case oracle + allowlist reason + lock | BLOCKED_EXTERNAL |
| B-02 | 30 non-empty children on an authorized frontier provider | authority / `UPG-07` | Authorized real provider budget at N=30 | oracle "mock结果不替代本门" + lock | BLOCKED_EXTERNAL |
| B-03 | 31 kernels' RSS/CPU/pids under budget | authority / `RES-05` | 30 real children, each a real kernel | milestone FINDINGS, quoted | BLOCKED_EXTERNAL |
| B-04 | Role change: reuse a kernel across read-permission domains | authority / `SEC-08` | A **second** execution world | P3-security FINDINGS, quoted | BLOCKED_EXTERNAL |
| B-05 | One path string resolves to one world across native/process/Web | authority / `DEP-04` | Any SSH execution world at all | six-gate analysis, quoted | BLOCKED_EXTERNAL |
| B-06 | Verification environment is low-privilege vs the host | authority / `VER-04` | A seam that can express it (upstream ABI), or a VM boundary | `docs/GAPS.md` G-VER-03, quoted | BLOCKED_EXTERNAL (upstream) |
| B-07 | Paid model evaluation: attempt accounting, real total cost, fixed-identity comparison, paired quality runs | authority / `ECO-01`…`ECO-08` | An authorized paid model budget | tier definition + G-EXT-02 + R9 | BLOCKED_EXTERNAL |
| B-08 | Live search against the ported provider | old 104-gate / `R01` | A search credential | gates.json row, quoted | BLOCKED_EXTERNAL |
| B-09 | Live N=10 run on a paid provider | old 104-gate / `C01` | Authorized paid budget (T1 half IS measured) | gates.json row, quoted | BLOCKED_EXTERNAL |
| B-10 | Paired comparison stock vs IPython | old 104-gate / `U04` | Authorized paid budget | G-EXT-02 | BLOCKED_EXTERNAL |
| B-11 | Vendor benchmark reproduction | **no case** | A vendor benchmark, and a spec that names one | audit `not_executed`; nothing in the repo | BLOCKED_EXTERNAL — **and unspecified** |
| B-12 | Isolated executor VM qualification | audit `not_executed` | A VM/container execution world | same as B-04/B-05 | BLOCKED_EXTERNAL |
| U-01 | 112 authority cases with no verdict | authority / 100 cases not in B-02…B-07 | nothing — nobody ran them | `NOT_RUN=112` | **UNATTEMPTED** |
| U-02 | Upstream DSH build and full test suite | audit `not_executed` | nothing — deliberately not run | R9 CLAIM-CHECK D-11, quoted | **UNATTEMPTED** (deliberate) |
| F-01 | 13 mandatory FAILs | trusted-local v1 | nothing — these were run | gate check 3 | **FAIL / DEFECT** |
| F-02 | `SEC-01`, `SEC-03` (host secret, egress) | authority / `SEC-01`, `SEC-03` | nothing — measured non-denial | `not_applicable_inherited`, quoted | **PERMANENT NON-CLAIM** |
| P-01 | `STALE IDENTITY` | gate check 2 | nothing — a missing commit | §0.4 | **BOOKKEEPING** |
| P-02 | 3 stale digests | gate check 7 | nothing — filing drift | §0.3 | **BOOKKEEPING** |
| P-03 | 314 identity stamps | gate check 1 | nothing — evidence filed pre-move | §0.3 | **BOOKKEEPING** |
| P-04 | 0 of 61 assembled-product PASSes at the current identity | gate check 9 | nothing — needs a re-run | gate check 9 | **BOOKKEEPING (consequence of P-01)** |

### 1.3 The blocked items in detail

---

#### B-01 — `IPY-08`, the one case the allowlist sanctions

**What is blocked.** The requirement "a natural activation end rebinds or reports loss explicitly",
at layer `T5`, the only `BLOCKED_EXTERNAL` case in the 109-case trusted-local spec.

**Exactly what external thing is missing.** An authorized live provider budget, enough to drive a
real continuable child to a *natural activation end* and observe what the kernel does. Not a
credential — an **authorization**.

**The evidence it is genuinely blocked, not merely unattempted.** Three independent statements,
all quoted:

1. The case's own oracle, verbatim from the spec:

   > The kernel is either legitimately rebound to the continuing session, or the epoch loss is
   > stated explicitly with what was lost. A silent restart presented as continuity is NOT PASS.
   > **This case needs a live provider and is expected BLOCKED_EXTERNAL while
   > `live_provider_budget_authorized` is false.**

2. The allowlist's own reason for sanctioning it, verbatim from
   `qualification/runners/release-gate.py`:

   > IPY-08 needs a live provider driving a real continuation: the oracle is that a natural
   > activation end either rebinds the kernel to the continuing session or states the epoch loss
   > explicitly, and neither can be observed without a live model. The case's own oracle text says
   > it is expected BLOCKED_EXTERNAL while live_provider_budget_authorized is false.

3. The lock's authorization block, read from `compatibility.lock.json`:

   ```json
   "runtime_authorization": {
     "scope": "LOCAL_IMPLEMENTATION_ONLY",
     "live_provider_budget_authorized": false,
     "budget_amount": null,
     "currency": null,
     "deadline": null,
     "restart_resume_authorized": false,
     "external_publication_authorized": false
   }
   ```

   `budget_amount` is `null`. There is no budget to spend even if the flag were flipped.

And the spec's `reading_notes.blocked_external` states the layer rule:

> Cases at layer T5 need an authorized live provider. compatibility.lock.json ->
> runtime_authorization.live_provider_budget_authorized is false, so they are expected to remain
> BLOCKED_EXTERNAL. That is a recorded blocker, not a PASS and not a reason to lower the layer.

**What would unblock it.** An explicit budget authorization recorded in the lock
(`live_provider_budget_authorized: true` with a non-null `budget_amount`), followed by running the
stimulus: a continuable child ends its activation while the session legitimately continues, and the
observer records whether the kernel was rebound or the epoch loss was stated. Note the consequence
of that flip, measured in §2.3: the moment the flag becomes `true`, the allowlist entry **stops
applying by itself** and `IPY-08` becomes a *required* case. The allowlist is not a permission slip.

**What the product CAN establish without it — clearly labelled.**

- `[REAL]` **`IPY-14` (T3, PASS): "kernel death is visible and nothing is replayed."** T3 means a
  real subprocess kill and real disk recovery. This is a real kernel, really killed, with the loss
  surfaced. It is not the same oracle — it is an *unnatural* end, which is why it does not
  substitute for `IPY-08` — but it is real, not mocked.
- `[REAL, WITH A STATED LIMIT]` **`IPY-07` (T2, PASS): "interrupt then reuse, with honest outcome
  classification."** The spec's own reading is that this is met through the requirement's own
  escape hatch (`unknown` + reset + epoch advance), and that this is **not** a graceful
  `KeyboardInterrupt` and is not claimed as one.
- `[MOCK]` **A scripted local adapter can drive children.** The capacity family does exactly this,
  and it establishes **mechanical** admission, refill and refusal — no model reasoning, no
  provider. `qualification/results/V8-capacity/GATES.md` states the limit in its own words: *"No
  live paid provider. `UPG-07` stays BLOCKED_EXTERNAL — no authorized budget on this machine. The
  children here run on a scripted local adapter, so these gates prove MECHANICAL admission and
  refill, not a provider result."* **This mock does not satisfy `IPY-08`, and nothing here presents
  it as if it did.**

---

#### B-02 — `UPG-07`: 30 non-empty children on an authorized frontier provider

**What is blocked.** The authority spec's `UPG-07`, tier `integration`: "授权frontier provider驱动
30个非空child" — an authorized frontier provider driving 30 non-empty children, with the
maintenance/top-up record actually observed.

**Exactly what external thing is missing.** An authorized real provider budget, sufficient for 30
simultaneous non-empty children. Same authorization as B-01, at a scale 3× the largest real
measurement this repo has.

**The evidence it is genuinely blocked.** The oracle itself forbids the substitute, verbatim:

> 实际维持/补位记录；**mock结果不替代本门** ("actual maintenance/top-up record; **mock results do not
> substitute for this gate**")

The authority's own specification adds the disposition:

> UPG-07必须有已授权真实provider预算，否则BLOCKED_EXTERNAL但仍NOT_READY
> ("UPG-07 must have an authorized real-provider budget; otherwise BLOCKED_EXTERNAL but still
> NOT_READY")

And the repo's own filing:

> ### UPG-07 real 30-provider — **BLOCKED_EXTERNAL**
> **Exact reason, from `compatibility.lock.json`:** `runtime_authorization.live_provider_budget_authorized: false`
> … The gate's own text forbids a substitute — the spec's UPG-07 oracle reads **mock结果不替代本门**
> … **Nothing in this work manufactures a result for this gate.** No provider-driving API is called
> anywhere in `upg-gates.test.ts` … The mock-based N=10 result exists as its own evidence and is
> asserted to be a **different fact**, not a stand-in.
> — `qualification/results/M-DEP-SEC-UPG/FINDINGS.md`

**N precision — this is the number a reader must not blur.** A run with 10 children does not
satisfy a 30-child oracle, and a run on a scripted adapter does not satisfy a provider oracle. The
two largest real measurements in this repository are:

| Measurement | N | Route | Source |
|---|---|---|---|
| Ten children in flight, the 11th refused, root holds no slot | **10** | scripted local adapter | `qualification/results/V8-capacity/cap01-n10-real.txt` — `✓ REAL N=10: ten children in flight, the 11th refused, and the root holds no slot`, `EXIT_CODE=0` |
| The cap boundary of 30 | **29 arithmetic reservations + 1 real creation call** | mixed | `qualification/results/T10-capacity/GATE-TABLE.md` §7 — *"the cap boundary is reached with 29 arithmetic reservations plus ONE real creation call; the arithmetic is the evidence for the boundary, and the real call is the evidence that the boundary binds"* |

**N=30 real children on a provider has never been run here.** The repo says so in three places, and
one of them explicitly warns the reader against the overclaim:

> **30 real children refused at the *live* deployment cap of 30.** **PARTIAL — and this is the most
> important limitation to read.** … The *live* refusal tests run at N=1/3 … **A reader must not read
> "30 real children were refused" out of this file.**
> — `qualification/results/M12-capacity/FINDINGS.md`

**What the product CAN establish without it — clearly labelled.** `[MOCK]` The mechanical
admission/refill/refusal behaviour at the deployment numbers, on a scripted local adapter: the cap
constant is asserted to be 30; "31st refused, never > 30" is proven at N=30 with synthetic
occupancy; a genuine refused `startContinuable` was observed on a composed boot. That is a real
result about the **mechanism**, and it is **not** a provider result. Per the gate's own text it does
not substitute for `UPG-07`.

---

#### B-03 — `RES-05`: 31 kernels' RSS

**What is blocked.** Tier `fault_injection`: "30children真实启动kernel并保持大对象" → RSS/CPU/pids
counted against the budget, with an explicit block when resources are insufficient.

**Exactly what external thing is missing.** 30 real children, each starting a real kernel and
holding large objects. Blocked on the same budget as B-02 **and** on this machine's capacity.

**The evidence it is genuinely blocked.** Filed as `NOT_RUN`, with the reason and the dependency
named:

> **RES-05: 31 kernels' RSS.** **NOT_RUN.** This is the resource measurement the plan asks for at
> M6.10; it needs 30 real children, so it is blocked by the same external budget as #1.
> — `qualification/results/M12-capacity/FINDINGS.md` §4

**What the product CAN establish without it — clearly labelled.** The budget accounting
**mechanism** exists and is unit-tested: `kernel-lifecycle.ts` implements `recordNestedCall`,
`recordDataBytes`, `rssBytes`, `processCount`. But — and the repo says this in its own words — *"a
budget that is implemented and tested is not the same as a budget reached through the product"*, and
the authority spec's `RES-05` is recorded as **NOT ESTABLISHED under these ids**. A unit test of a
budget function is `[MOCK]`-class evidence for the mechanism and no evidence at all for the oracle.

---

#### B-04 — `SEC-08`: role change, reuse a kernel across read-permission domains

**What is blocked.** Tier `security`: after a read-permission-domain or project change, reusing the
kernel must take a new epoch or a controlled migration, and must not carry the old domain's secret
variables across.

**Exactly what external thing is missing.** A **second execution world.** The deployment configures
exactly one, and a migration needs two.

**The evidence it is genuinely blocked.** Two quotes, both explicit that a simulation is refused:

> **The cross-world half cannot be exercised here.** The architecture's production answer is
> provisioning, not code — *"同一项目family可以读共享source；其他项目或不同读权限域使用独立execution
> world/VM"* … The package patch configures exactly one world (`executionWorld: local` in
> `packages/dsh-ipython/cordis.patch.yml`), and no container/VM/SSH execution world is mounted in
> this composition. **A migration needs two worlds. Per the acceptance spec a simulated second world
> would not substitute**, and `live_provider_budget_authorized` is `false`.
> — `qualification/results/P3-security/FINDINGS.md`

> SEC-08 | BLOCKED_EXTERNAL | The kernel half of the oracle HOLDS and is measured on the live plane
> … The migration half EXISTS and is correct (`changeReadPermissionDomain`,
> `kernel-lifecycle.ts:2122`) but has no production importer and is not exported. The cross-world
> half cannot be exercised … a migration needs TWO worlds, and per the spec a simulated one does not
> substitute. NOT_RUN understated it: the fixture is not unbuilt, **the required environment is
> unavailable.**
> — same file

**What would unblock it.** Provisioning a second execution world (VM/container/SSH) and mounting it.
This is an infrastructure action, not a code change.

**What the product CAN establish without it — clearly labelled.** `[REAL]` The kernel half is
measured on the live plane: `KernelService.entryFor` refuses a changed execution world and does not
silently replace the kernel. `[DEFECT]` The migration half is correct code with **no production
importer** and no export — the project's recurring "implemented, tested, correct, nothing calls it"
shape (`G-SEAM-25`). Neither half establishes the oracle, which is about the *transition*.

---

#### B-05 — `DEP-04`: one path string, one world, across four entry points

**What is blocked.** Tier `integration`: the same path viewed through native `read`/`grep`/process/Web
must resolve to the same execution world, and must not silently read a same-named host file.

**Exactly what external thing is missing.** Any SSH execution world. DSH ships four first-party SSH
providers; **no shipped bundle patch mounts them**, so the deployment has one world and the
consistency question has no object.

**The evidence it is genuinely blocked.** The repo's own analysis is unusually direct about the
distinction between "passed" and "nothing to test":

> **Why it is NOT_RUN: 这门的整个前提就是"存在多个执行世界"** … 但**没有任何 shipped bundle patch
> 挂载它们**，所以部署里只有一个世界，"路径一致性"无从谈起——**不是通过，是没有可测对象**.
> ("The entire premise of this gate is that multiple execution worlds exist … but no shipped bundle
> patch mounts them, so the deployment has exactly one world and 'path consistency' cannot even be
> discussed — **not passed, but no testable object**.")
> — `docs/decisions/2026-09-20-six-gate-impact-explained.md`

The same document names the honest consequence: in a single-world deployment the oracle is
**vacuously true**, so leaving it as `NOT_RUN` invites a reader to think verification is owed.

**What the product CAN establish without it — clearly labelled.** `[REAL, SINGLE-WORLD HALF]`
`FS-03` (T2, PASS): one path string resolves to one file in one world, measured through four real
routes — the native `read` tool, the native `grep` tool, a **spawned process**, and a **Python cell**,
all reaching the same digest. That is a genuine result and it is the single-world half only. **It
does not establish cross-world consistency, because there is no second world.** The `C8` integration
boot confirms the same at the assembled level: *"all four routes reached the same file in one world"*.

---

#### B-06 — `VER-04`: the verification environment must be low-privilege

**What is blocked.** Tier `security`: candidate tests that try to read a host secret or open a
network connection must be blocked, so that "the candidate passed verification" means something.

**Exactly what external thing is missing.** A seam that can express the boundary — or a VM boundary
outside the runner. `SandboxPolicy` extends `SandboxExecutionPolicy`, whose only members are `mode`,
`workspaceRoot` and an optional `sessionId`; `mode` is `'read-only' | 'workspace-write'`. Upstream's
own comment: *"Network and process visibility are outside this vocabulary."*

**The evidence it is genuinely blocked.** Filed as `BLOCKED_EXTERNAL (CONFIRMED)` with the reasoning:

> **VER-04 has no fix expressible through the public sandbox seam, so the gate stays an honest
> FAIL.** … **There is no read-restriction lever and no egress lever in the type** … On Windows the
> mechanism is a `WRITE_RESTRICTED` token, which by construction intersects only write accesses. So
> a confined verification child can still READ outside its snapshot and open a network connection
> (both measured, exit 0). **Closing this needs a VM/container/read-deny ACL boundary OUTSIDE the
> runner — not a change inside it.** … **UPSTREAM limitation, correctly recorded; the gate is not
> narrowed and not turned green.**
> — `docs/GAPS.md`, `G-VER-03`

**What would unblock it.** An upstream change to the sandbox ABI, or an external VM/container
boundary. Both are outside this repository.

**What the product CAN establish without it — clearly labelled.** Nothing that establishes the
oracle. The meta-consequence must be stated rather than buried: on this deployment the verification
environment has the same privilege as the host, so the strength of *"the candidate passed
verification"* is bounded by that fact. The 9 `VER` cases in the trusted-local spec are PASS, and
they test whether the **verification mechanism** is correct; they do not and cannot test whether the
**verification environment** is trustworthy. A reader who sees "9/9 VER PASS" and concludes the
latter is reading a claim nobody made.

---

#### B-07 — `ECO-01`…`ECO-08`: paid model evaluation

**What is blocked.** The authority spec's whole `evaluation` tier — 8 mandatory cases: attempt
accounting under retry (`ECO-01`), missing-usage handling (`ECO-02`), real total cost across root +
children + summary + search + cache/storage (`ECO-03`), prefix stability (`ECO-04`), the
token-reduction counterexample (`ECO-05`), shadow projection with no second LLM request (`ECO-06`),
a strict C0 comparison of stock vs IPython/data-plane (`ECO-07`), and paired quality runs with
variance and confidence intervals (`ECO-08`).

**Exactly what external thing is missing.** An authorized paid model budget. Every one of these
cases is *about* model usage, so a mock provider cannot produce the quantity being measured.

**The evidence it is genuinely blocked.** The tier's own definition, verbatim from the authority:

> evaluation需要固定身份的对照与原始结果 ("evaluation requires a fixed-identity comparison and raw
> results")

and, from the repo, the standing rule and its consequence for exactly these cases:

> | G-EXT-02 | A model API key being present does not authorize large paid evaluation. |
> BLOCKED_EXTERNAL | Gate C01's live N=10 run and U04's paired comparison stay blocked until the
> user authorizes a budget.
> — `docs/GAPS.md`

> Every claim about what a *model* does — the N=10 admission result's quality half, `A12`'s missing
> model turn, the paid halves of `ECO-07`/`ECO-08`/`UPG-07` — is unchecked here and **must stay
> `BLOCKED_EXTERNAL`**.
> — `qualification/results/R9-delivery/CLAIM-CHECK.md`

**What the product CAN establish without it.** `[NOT ESTABLISHED]` I checked whether accounting
mechanisms are unit-tested under these ids and did not verify any such evidence, so I state nothing
rather than something convenient. The honest entry is: **not established**, and a mock-provider
accounting test would establish the arithmetic, not the billing.

---

#### B-08 / B-09 / B-10 — the old 104-gate rows `R01`, `C01`, `U04`

These are `BLOCKED_EXTERNAL` / partial in `qualification/gates.json`, and they are **not cases of
either current spec**. They carry **no `deployment_identity` field**, so they are bound to no
candidate — which the README states as a warning rather than a footnote.

- **`C01` (强制10实际执行)** — `BLOCKED_EXTERNAL`, quoted: *"T1 MEASURED, T5 BLOCKED. At T1: 20 tasks
  submitted against target N=10; ten admitted and ten refused; ten DISTINCT children each reach a
  real model request in their own durable Session … T5 (a live paid run) stays BLOCKED_EXTERNAL:
  `live_provider_budget_authorized` is false, and a key being present would not authorize paid
  evaluation."* The same row carries a reachability caveat added 2026-09-20: `WorkService.createRun`
  had no production caller, so no user action could create the run the T1 numbers describe.
  **Cross-check:** `docs/GAPS.md` `G-SEAM-31` now records that as **RESOLVED** — a `/work start [N]`
  human command was mounted in the deliverable preset and *"a real composed-profile boot measured a
  durable run created by `/work start 10` with `authorizationRef` naming the human command
  (`qualification/results/R4-authorization/report-after.json`, 33/33)"*. The gate row and the GAPS
  row disagree; see §4.4.
- **`R01` (真实search链)** — `NOT_RUN` with a detailed partial: the four links are proven against
  different substrates (a controlled fake for retrieval, a **real** loopback HTTP server for fetch,
  range and citation), the failed-is-never-empty rule is asserted from both sides, and *"the live
  half (that a real search API answers in the shape the ported provider expects) is
  BLOCKED_EXTERNAL, because `live_provider_budget_authorized` is false."* The credential itself is
  absent: measured, `DEEPSEEK_API_KEY` ABSENT, `EXA_API_KEY` ABSENT, no `.credentials.yaml` for the
  writer homes — so both providers report `available() === false`.
- **`U04` (配对比较)** — `NOT_RUN`; blocked on the same budget per `G-EXT-02`.

---

#### B-11 — Vendor benchmark reproduction: **blocked and unspecified**

The authority's `not_executed` list names *"vendor benchmark reproduction"*. I searched both specs
and the whole repository for a case naming a vendor benchmark, and for benchmark evidence
(`grep -rn "vendor benchmark\|Terminal-Bench\|terminal-bench\|SWE-bench\|benchmark reproduction"`):
**zero hits outside this search itself.** No case in the 112-case authority spec names one; no case
in the 109-case trusted-local spec names one; no milestone directory holds one.

**This is a different kind of gap from the others and it must be stated as such.** It is not that a
named requirement was blocked — it is that a requirement the authority expects **was never taken
into this repository's scope at all**. There is nothing to unblock until a case exists. Recording it
as "blocked" without that sentence would overstate the repo's coverage; recording it as
"unattempted" without naming the missing case would understate the mismatch.

---

#### B-12 — Isolated executor VM qualification

The authority's `not_executed` names *"isolated executor VM qualification"*. This is the same
missing artifact as B-04 and B-05, viewed from the infrastructure side: no VM, container or SSH
execution world is mounted in this composition. **The authority's own remedy for the platform's read
and egress boundaries is a dedicated Linux execution VM — not a configuration change on this host**
(`qualification/results/M-DEP-SEC-UPG/FINDINGS.md`). Until such a world exists, `SEC-08`, `DEP-04`
and the isolation invariants cannot be exercised, and the authority spec says a simulated world does
not substitute.

---

### 1.4 What is NOT blocked — the unattempted population

**U-01 — 100 of the 112 authority cases have no verdict at all.** The authority spec reads
`NOT_RUN=112, evidence=[]` for every case. Of those 112, this register could establish an external
block with a quoted reason for **13** (B-02 through B-07: `UPG-07`, `RES-05`, `SEC-08`, `DEP-04`,
`VER-04`, and `ECO-01`…`ECO-08`). **The remaining ~99 are `NOT_RUN` and that is all that can be
said.** They are unattempted. Nobody has judged them under that spec.

I deliberately do **not** publish a precise count of "blocked vs unattempted" across all 112. Doing
so would require classifying every case individually, which is the C9 writer's full-inventory job,
and publishing a number I did not verify would be the exact overclaim this document exists to
prevent. What I can say with evidence is: **13 are externally blocked with a quoted reason; the rest
have no verdict, and no verdict is not a block.** The repo's own `MAIN-112-status/STATUS.md` adds
that 92 of the 112 are *named* by some evidence file under other labels — and is careful to state
that *"a mechanical mapping … proves a file mentions the id, not that the file establishes the
oracle"*, and that a case named only inside a "what is NOT proven" list is counted as **not
established**. Naming is not passing.

**U-02 — The upstream DSH build and full test suite were deliberately not run.** Quoted:

> | D-11 | §2 install commands | **VERIFIED (procedure re-run in part)** | The profile-install step was run end to end on three fresh homes; the `corepack pnpm install` and `pnpm build` steps were not re-run (a rebuild would invalidate the artifact hash every other agent is citing) |
>
> 4. **The `corepack pnpm install` and `pnpm build` steps.** Not re-run. A rebuild would change
> `apps/cli/lib/bin.js`'s sha256, which is a lock input and would invalidate the deployment identity
> every other agent is currently citing. The artifact hash was verified against the lock instead.
> 5. **The full test suite's pass/fail state.** Not run — explicitly out of scope, and other agents
> were running it. Only `vitest list` (collection, no execution) was run: **1084 across 47 files**.
> — `qualification/results/R9-delivery/CLAIM-CHECK.md`

**This is unattempted, not blocked**, and the distinction matters: nothing external prevents a
rebuild. It was declined because the rebuild would move a lock input and invalidate the identity
every other writer was citing — a deliberate trade-off, recorded as such. What the repo *did* run is
its own project suites, executed with the pinned checkout's `vitest` binary
(`node /d/DSH/src/dsh-src/node_modules/vitest/vitest.mjs run <file>`), which is a different thing
from upstream's suite.

**U-03 — The 13 `FAIL`s are verdicts, not blocks.** `ID-01`, `ID-05`, `ID-06`, `CMP-02`, `CMP-04`,
`IPY-13`, `IPY-15`, `BR-07`, `DATA-09`, `DATA-11`, `REC-09`, `REC-10`, `CAP-10`. Each was run and
each came back negative; each carries a note or evidence (verify-spec enforces that a `FAIL` must be
explainable). They are not waiting on anything external — they are waiting on a **repair or an
explicit re-judgement**. Three of them are named by the repo as reasons a user cannot use the
product as intended (`G-SEAM-31` run-creation, `G-SEAM-34` bridge unwired, `G-SEAM-33` sandbox row
mode), and the rest are recorded findings. On `cand-round3` the count is 9 rather than 13, because
four were re-measured (`CMP-02`, `BR-07`, `CAP-10`, `ID-06`); **`REC-09`/`REC-10` are recorded there
as a `NON-CLAIM` — the guard was deleted rather than left unwired** — which is a decision, not a
pass. On this tree they are still `FAIL`.

**U-04 — `SEC-01` / `SEC-03` in the authority spec are not blocked, not pending, and not claimed:
they are permanent non-claims, and the repo reclassified them out of scope.** The trusted-local trust
model states the absence outright, and the spec records these invariants as `NOT_APPLICABLE` in
`not_applicable_inherited` (not as cases). Quoted from that section:

> **SEC-01 host secret isolation** … The new architecture does not claim read isolation at any level.
> The old FAIL was measured, not assumed: a confined child read a canary file outside the workspace
> root verbatim, exit 0, under BOTH read-only and workspace-write, and four candidate levers were
> probed with none able to restrict a read.
>
> **SEC-03 egress isolation** … The new architecture does not claim a network boundary. The old FAIL
> was measured: a confined child completed a real HTTP round trip and reached a LAN address.

So the honest status is: **these can never be established on this machine, and they are not claimed.**
In the authority spec they remain mandatory cases with status `NOT_RUN`; in the trusted-local spec
they are `NOT_APPLICABLE`. **That difference is not a labelling choice — it is the repo declining
five of the authority's mandatory cases, and it is recorded in full in §4.3(d).** `SEC-08`, `DEP-04`
and `VER-04` are in the same set; see B-04, B-05 and B-06 above for what each one is blocked on.

---

## 2. THE ALLOWLIST MECHANISM

### 2.1 Where it lives and what it contains

`qualification/runners/release-gate.py`, `BLOCKED_EXTERNAL_ALLOWLIST` (line 92). It is a dict of
**case id → {reason, condition}**, and it has exactly one entry:

```python
BLOCKED_EXTERNAL_ALLOWLIST: dict[str, dict] = {
    "IPY-08": {
        "reason": (
            "IPY-08 needs a live provider driving a real continuation: the oracle is "
            "that a natural activation end either rebinds the kernel to the continuing "
            "session or states the epoch loss explicitly, and neither can be observed "
            "without a live model. The case's own oracle text says it is expected "
            "BLOCKED_EXTERNAL while live_provider_budget_authorized is false."),
        "condition": ("runtime_authorization", "live_provider_budget_authorized", False),
    },
}
```

### 2.2 The allowlist's own justification, verbatim

> THE BLOCKED_EXTERNAL ALLOWLIST. Each entry is a REASON with a CONDITION, not a permanent excuse:
> `condition` is re-evaluated against the lock on every run, so when the authorization flips the
> entry stops applying by itself. **An allowlist of bare case ids would be a list of permissions;
> this is a list of justifications.**

And the check that consumes it:

> 8. ONLY EXPLICITLY ALLOWLISTED BLOCKED_EXTERNAL. A case may stay blocked ONLY when it is named in
> the allowlist below AND the allowlist's stated authorization condition still holds. Rules out: a
> blocked case being quietly tolerated because it was blocked last time — the allowlist is a list of
> REASONS, and each one is re-checked against the lock rather than trusted.

### 2.3 The mechanism, precisely

For each case in the spec whose `status` is `BLOCKED_EXTERNAL`:

1. Look the case id up in `BLOCKED_EXTERNAL_ALLOWLIST`.
2. **No entry** → record `"<id> (not on the allowlist)"` as unauthorized.
3. **Entry present** → re-evaluate its `condition`, a 3-tuple
   `(section, key, expected)`, via `_lock_condition_holds(lock, condition)`, which reads
   `lock[section][key]` **from `compatibility.lock.json` on disk** and compares to `expected`. If it
   no longer holds → record `"<id> (allowlisted only while <section>.<key>==<expected>, which no
   longer holds, so the case is now required)"`.
4. Any unauthorized entry fails check 8 and appends the blocker
   `UNAUTHORIZED BLOCKED_EXTERNAL: N case(s) are blocked without an allowlist entry whose condition
   still holds`.

The condition is evaluated against the **lock**, not against the case's prose. So the entry is
self-retiring: it is a statement of the form *"this case is excused exactly while the authorization
that would be needed to run it is absent."*

**Two probes, both non-mutating, both confirming the mechanism.** Each used a temp copy; the repo's
spec and lock were not touched, and the temp files were deleted afterwards.

**Probe A — a new `BLOCKED_EXTERNAL` case fails check 8 unless the allowlist is amended.** I copied
the spec to a temp file, set `FS-01` to `BLOCKED_EXTERNAL`, and called `decide(spec_path=tmp)`:

```
CHECK8: False | FS-01 (not on the allowlist)
blockers containing UNAUTHORIZED: ['UNAUTHORIZED BLOCKED_EXTERNAL: 1 case(s) are blocked without
  an allowlist entry whose condition still holds']
temp spec removed: True
```

**Probe B — the condition is genuinely re-checked, and the entry retires itself.** I copied the lock
to a temp file and set `runtime_authorization.live_provider_budget_authorized` to `true`:

```
ARM A condition holds (real lock, flag false): True
ARM B condition holds (temp lock, flag true):  False
CHECK8 with flipped lock: False | IPY-08 (allowlisted only while
  runtime_authorization.live_provider_budget_authorized==False, which no longer holds, so the case
  is now required)
real lock untouched: False
```

So granting the budget does not merely permit running `IPY-08` — it **makes the case mandatory
again** and the gate refuses to release while it remains `BLOCKED_EXTERNAL`. That is the design
intent, and it is load-bearing: the excuse cannot outlive its condition.

### 2.4 Does adding a new `BLOCKED_EXTERNAL` case require amending the allowlist? **Yes.**

- **`release-gate.py` enforces it.** Probe A above is the proof: an unlisted `BLOCKED_EXTERNAL` case
  fails check 8 and adds a blocker. Since `releasable = not blockers and all(checks)`, the candidate
  cannot be released.
- **`verify-spec.py` does not.** It has no knowledge of the allowlist or of layer T5. Its only
  related rule is rule 7: a case with status `NOT_RUN`, `BLOCKED_EXTERNAL` or `RUNNING` must carry
  **no** evidence (`NON_VERDICT_STATUSES`; *"a non-verdict should carry none"*). So a case could be
  flipped to `BLOCKED_EXTERNAL` and still pass verify-spec, and would then be caught only by
  release-gate check 8. The allowlist is enforced in exactly one place.
- **Consequence for a future writer:** adding a `BLOCKED_EXTERNAL` case is a two-part act — the
  verdict, *and* an allowlist entry carrying a reason and a condition that can be re-checked against
  the lock. A bare case id cannot be added, because the structure has no field for one.
- **I did not amend the allowlist.** The only entry remains `IPY-08`.

---

## 3. THE READINESS STATEMENT

### 3.1 What the gate currently says, quoted

```
RELEASE=NOT_READY blockers=4 candidate=533c8cb08b2ccd7f
```

with, verbatim:

```
release-gate: NOT_READY -- 4 blocker(s):
  - STALE IDENTITY: recorded 533c8cb08b2ccd7f... != recomputed 152e5c45c4aef97b...
  - FAIL: 13 mandatory case(s) failed
  - STALE EVIDENCE: 3 evidence file(s) missing or hash-mismatched
  - NO POST-INTEGRATION ASSEMBLED-PRODUCT EVIDENCE: no T2/T3/T4/T6 case carries a PASS with
    evidence stamped at the current identity. This is the check that makes 'a gate that is not run
    post-integration is not a gate' mechanical
```

**A fifth check fails and is not in that list.** Check 1, `verify-spec passes`, reads `[FAIL] 317
problem(s)`, but check 1 never appends to `decision.blockers` — reading the source, checks 2, 3, 4,
5, 6, 7, 8 and 9 each append a blocker on failure and check 1 does not. The verdict is still correct
(`releasable` is `not blockers and all(checks)`, so the failing check does force `NOT_READY`), but
**a reader who counts the printed blockers under-counts the failing conditions by one.** On this
tree: 5 failing checks, 4 named blockers.

On the integration branch `cand-round3` the same asymmetry is starker: its gate prints
`blockers=1` while check 1 also fails with 315 problems, so *"one blocker"* there means *"one named
blocker, plus verify-spec"*, not *"one thing wrong"*.

### 3.2 Which blockers are genuine product/evidence gaps, and which are bookkeeping

| Blocker | Category | Why |
|---|---|---|
| `FAIL: 13 mandatory case(s) failed` | **Genuine product/evidence gap** | Thirteen mandatory cases were run and came back negative. This is the only blocker that is about the product. |
| `NO POST-INTEGRATION ASSEMBLED-PRODUCT EVIDENCE` (0 of 61) | **Genuine evidence gap, caused by bookkeeping** | The oracle is real and important — no T2/T3/T4/T6 PASS carries evidence stamped at the current identity, so nothing shows the *assembled* product works at this identity. Its cause is that the identity moved and the evidence did not. `cand-round3` reaches 3 of 64. |
| `STALE IDENTITY` | **Process/identity bookkeeping** | Two profile inputs moved by intended edits; the re-derivation commit exists on `cand-round3` and not at this branch point. No product behaviour is implicated. |
| `STALE EVIDENCE` (3) | **Process/identity bookkeeping** | Three evidence files were edited after their digests were filed. `cand-round3` records the on-disk digests for all three. |
| *(unnamed)* check 1: 314 identity-mismatch problems | **Process/identity bookkeeping** | Every evidence entry was filed under `0a0996f3944b5528…`; the lock records `533c8cb08b2ccd7f…`. The mechanism working as designed — and the reason no verdict here is currently evidence for this tree. |

**How many of the four named blockers are about the product? One.** Three are bookkeeping and one is
a real evidence gap whose cause is bookkeeping. That is worth stating plainly, because it cuts both
ways: it means the *record* is in worse shape than the *product* on three of four counts — and it
also means fixing the bookkeeping would leave the 13 `FAIL`s untouched, so **`NOT_READY` is not a
bookkeeping artefact.** Removing every bookkeeping blocker still yields `NOT_READY`.

### 3.3 What `NOT_READY` means concretely

`NOT_READY` is a statement about **the record**, and the gate says so itself:

> A green release-gate is a statement that the RECORD is releasable, not that the product is
> correct -- and the record is only as good as the oracles in it, which this file cannot judge.
> — `release-gate.py`, module docstring

Concretely, on this tree, `NOT_READY` means exactly four things:

1. **No verdict in the trusted-local spec is evidence for the artifact the lock records.** 0 of the
   108 evidence-bearing cases have all their evidence stamped with the recorded identity; 314 of 317
   entries are stamped `0a0996f3944b5528…`, the identity that predates the round-3 profile change.
   So "95 PASS" is a true statement about a superseded identity and is **not** a statement about
   this tree. The spec's own `no_inheritance_rule` is the same rule one identity further back:
   *"NO PASS IS INHERITED … A case here is PASS only when it has its own evidence file, recorded
   under THIS identity."*
2. **Thirteen mandatory cases carry a negative verdict.** The release rule requires no `FAIL`.
3. **No assembled-product PASS carries current-identity evidence**, so nothing establishes that the
   composed profile — a real boot, real disk, real processes — works as recorded.
4. **Therefore the release gate would refuse to release this candidate**, and would do so even if
   every bookkeeping blocker were cleared.

**What `NOT_READY` does not mean.** It does not mean the product is broken wholesale, and it does
not mean nothing was measured. 95 cases carry PASS verdicts, 108 of 109 cases carry evidence, and
the evidence files exist and hash correctly apart from the three named. The honest reading is:
*a large amount was measured, under an identity that no longer describes this tree, and thirteen
things were found to be wrong.* Those are three separate facts and the register keeps them separate.

### 3.4 The smallest set of measurements that could flip it

**There is no set of measurements alone that flips this gate, and saying otherwise would be the
overclaim this document exists to prevent.** Check 3 requires zero `FAIL`s; a measurement cannot
make a negative verdict disappear, only a repair or an explicit re-judgement can. So the honest
answer has two parts.

**Part 1 — the bookkeeping, which measurement cannot substitute for.** It is tempting to say the
smallest fix is "re-stamp the 314 evidence entries to the current identity". **That must not be
done, and this register explicitly refuses to recommend it.** The identity moved because two profile
files changed; the evidence was produced *before* that change; re-labelling it would assert that a
measurement taken on a different artifact is a measurement of this one. That is precisely the
`--summary` false-green and the stale-citation defect this project keeps recording. The identity
mechanism exists to make that move impossible, and it is working. **The only legitimate route is
re-measurement at the adopted identity.**

**Part 2 — the honest minimum, in order.** Each item names what it establishes and who owns it:

| # | Item | What it clears | Kind |
|---|---|---|---|
| 1 | Adopt the identity move (`cand-round3` commit `5b014e9`) | `STALE IDENTITY` | commit, not a measurement |
| 2 | Re-file the 3 stale digests against the files on disk (`cand-round3` records all three correctly) | `STALE EVIDENCE` | filing |
| 3 | **Re-measure the 95 `PASS` cases at the current identity** | the 314 identity problems, and check 9's precondition | **the large item — this is a full re-run, not a re-label** |
| 4 | **Repair, or explicitly re-judge, the 13 `FAIL`s** | `FAIL: 13 mandatory case(s) failed` | code changes + re-measurement; **out of scope for this slice** |
| 5 | Produce ≥1 `T2`/`T3`/`T4`/`T6` `PASS` carrying evidence stamped at the adopted identity | `NO POST-INTEGRATION ASSEMBLED-PRODUCT EVIDENCE` | one real boot, done post-integration |

**The smallest flipping set is not small.** Items 1 and 2 are cheap and are already done on
`cand-round3`. Item 3 is a re-run of 95 cases. Item 4 is a repair programme on thirteen findings,
three of which the repo names as reasons a user cannot use the product as intended. Item 5 is one
post-integration boot. **And the gate cannot flip on a proper subset:** `releasable` requires *every*
check green, so clearing three of the four blockers still prints `NOT_READY`.

### 3.5 What can NEVER be established on this machine under the current authorization

Stated as a limit, not as a work queue. Nothing on this list is "later"; each is blocked on an
artifact this machine does not have and, in several cases, cannot have.

1. **`IPY-08`'s oracle** — a natural activation end observed under a live provider. Needs an
   authorized live provider budget. `budget_amount` is `null`.
2. **`UPG-07`** — 30 non-empty children on an authorized frontier provider, with the maintenance
   record actually observed. Its own oracle forbids a mock substitute. The largest real N measured
   here is **10**, on a scripted adapter.
3. **`RES-05`** — 31 kernels' RSS/CPU/pids under a real budget. Needs 30 real children.
4. **`SEC-08` and `DEP-04`** — any cross-execution-world property. Needs a second world; the
   authority states a simulated one does not substitute.
5. **`VER-04`** — a low-privilege verification environment. Not expressible through the public
   sandbox ABI, which has no read and no egress lever; needs an upstream change or an external VM.
6. **`ECO-01`…`ECO-08`** — the entire paid-evaluation tier: attempt accounting, real total cost,
   fixed-identity comparison, paired quality runs with variance and confidence intervals.
7. **`SEC-01` / `SEC-03`** (host-secret read isolation, egress isolation) — **never establishable and
   never claimed.** The trusted-local trust model states the absence outright; the spec records them
   as `NOT_APPLICABLE`; the repo's own analysis calls the first *"不是'以后做'，是'已决定不做'"*
   ("not 'do later', but 'decided not to do'").
8. **A vendor benchmark reproduction** — and, unlike the others, **there is no case for it in either
   spec.** Nothing can be established because nothing is specified.
9. **Upstream DSH's own build and full test suite**, as a *rebuild* — it would move
   `apps/cli/lib/bin.js`'s sha256, a lock input, and invalidate the identity every other result
   cites. It is not blocked by the platform; it is blocked by the identity mechanism itself.

---

## 4. THE AUTHORITY CROSS-CHECK

**Authority read:** `C:\Users\hzq00\Downloads\DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20\dsh-audit-2026-09-20\delivery\AUDIT_STATUS.json`
and `ACCEPTANCE.zh-CN.md` in the same directory. Both read-only; nothing was written there.

### 4.1 The audit's own status, verbatim

```json
{
  "audit_date": "2026-09-20",
  "personal_repository_commit": "4a74736cdf36ae153898a70c6520e0eb423d2b07",
  "upstream_commit": "ddefc45fbc7f8e46dd73185e68295696d1297887",
  "connector_failures": [
    "Consensus monthly search quota reached",
    "repository clone DNS resolution failed"
  ],
  "executed": { "ipython_mechanics_passed": 8, "standalone_lock_race_reproduced": true },
  "not_executed": [
    "DSH build or test suite",
    "production WorkService reproduction",
    "isolated executor VM qualification",
    "30 real DSH children",
    "paid model evaluation",
    "vendor benchmark reproduction"
  ],
  "new_acceptance_cases": 112,
  "new_acceptance_status": "ALL_NOT_RUN",
  "production_qualification": "NOT_READY"
}
```

### 4.2 Where the authority and the repo agree — verified, not assumed

| Authority claim | Repo check | Result |
|---|---|---|
| `new_acceptance_cases: 112` | `acceptance-spec.json` has 112 cases | **AGREE** |
| `new_acceptance_status: "ALL_NOT_RUN"` | `Counter` over its statuses = `{NOT_RUN: 112}` | **AGREE** |
| `production_qualification: "NOT_READY"` | `compatibility.lock.json` → `promotion.decision` = `NOT_READY` | **AGREE** |
| the 112-case spec is the same object as the audit package's | `sha256(repo acceptance-spec.json)` = `2fe95835425eb98eb3bac9eead17985df5bf951669460c8d7a87b8887afb1e0b` = `sha256(delivery/acceptance-spec.json)`; **byte-identical**, `json-equal: True` | **AGREE** |
| `upstream_commit` | `git -C D:\DSH\src\dsh-src rev-parse HEAD` = `ddefc45fbc7f8e46dd73185e68295696d1297887` | **AGREE** |
| `"30 real DSH children"` not executed | max real N measured = 10 (`V8/cap01-n10-real.txt`); cap boundary reached with 29 arithmetic reservations + 1 real call | **AGREE, and the repo is more precise** |
| `"paid model evaluation"` not executed | `live_provider_budget_authorized: false`; `UPG-07` BLOCKED_EXTERNAL | **AGREE** |
| `"isolated executor VM qualification"` not executed | no VM/container/SSH world mounted; `SEC-08`/`DEP-04` unestablishable | **AGREE** |
| `"DSH build or test suite"` not executed | `R9-delivery/CLAIM-CHECK.md` D-11 and item 5, quoted in §1.4/U-02 | **AGREE** |

The two agreement claims worth stressing, because they are checkable by hash rather than by reading:
**the authority spec is byte-identical to the repo's**, and **the authority's verdict equals the
repo's own recorded promotion decision**. Neither is asserted; both were computed.

### 4.3 Where they differ, and which is right

**Difference 1 — the authority's `ALL_NOT_RUN` is true of its object and incomplete as a
description of the repository.**

- *Authority:* `new_acceptance_status: "ALL_NOT_RUN"` — true of the 112-case spec.
- *Repo:* the 112-case spec **is** all `NOT_RUN` (never updated, `evidence: []` on every case). But
  the repo also contains a **second, later spec** — `acceptance-spec.trusted-local-v1.json`, 109
  cases — which the authority does not mention at all, and in which **108 of 109 cases carry
  evidence** and the distribution is `PASS=95, FAIL=13, BLOCKED_EXTERNAL=1`.
- **Which is right:** both, about their own objects, and the difference is one of scope rather than
  of fact. The authority is not wrong — its 112 cases genuinely have no verdicts. But a reader who
  takes `ALL_NOT_RUN` as the repository's status would conclude *nothing has been executed*, which
  is false here: 317 evidence entries exist, 108 cases carry them, and the repo's own
  `MAIN-112-status/STATUS.md` records that 92 of the 112 ids are named by evidence filed under other
  labels. **The authority's verdict (`NOT_READY`) survives; its status summary does not travel.**
  The honest statement is: *the 112-case spec is all `NOT_RUN`; a later 109-case spec is largely
  executed and still `NOT_READY`.*

**Difference 2 — `"production WorkService reproduction"` is recorded as not executed, and the repo
records it as resolved.**

- *Authority:* listed under `not_executed`.
- *Repo:* `docs/GAPS.md` `G-SEAM-31` — *"RESOLVED — was: `OPEN`, 'nothing in the product creates a
  run'. **The missing entry point now exists**: `src/command-work.ts` registers `/work start [N] |
  target N | stop | status` through DSH's HUMAN command registry, mounted in the deliverable preset
  (`agent.cordis.yml:384-385`), and a real composed-profile boot measured a durable run created by
  `/work start 10` with `authorizationRef` naming the human command
  (`qualification/results/R4-authorization/report-after.json`, 33/33)."*
- **Which is right:** **the repo's later measurement is right for this tree**, and the authority's
  entry is a statement about its own run, not about this tree. Two facts support that rather than
  merely asserting it: (a) the repo names the artifact and the check count, so the claim is
  falsifiable; (b) the authority's own `personal_repository_commit` is
  `4a74736cdf36ae153898a70c6520e0eb423d2b07`, and **that object does not exist in this repository** —
  `git cat-file -t 4a74736c` returns `fatal: Not a valid object name`. So the authority's snapshot
  is a commit I cannot resolve, and I cannot verify its `not_executed` list against any tree I can
  read. **I record the divergence and the evidence on each side; I do not claim the authority was
  wrong about its own run.** What I can say is that on the tree in front of me, the reproduction
  exists as a named artifact.

**Difference 3 — `"vendor benchmark reproduction"` has no counterpart in the repo.**

- *Authority:* listed under `not_executed`, implying it is a known, specified piece of work.
- *Repo:* **no case in either spec names a vendor benchmark, and no benchmark evidence exists**
  (search recorded in §1.3/B-11).
- **Which is right:** the authority, in the sense that it is naming a real gap. But the gap is
  larger than "not executed" — the work was **never scoped into this repository**. Reporting it as
  merely unexecuted would understate the mismatch; reporting it as blocked would overstate the
  repo's coverage, since there is no case to block.

### 4.4 Repo-internal divergences found while cross-checking

These are not authority-vs-repo; they are places where the repo's own documents disagree, which a
hostile auditor would find. Each is stated with which document is right.

**(a) The lock's `promotion` block pairs a path with the wrong file's digest.** Verbatim from
`compatibility.lock.json`:

```json
"spec_path": "qualification/specs/acceptance-spec.trusted-local-v1.json",
"spec_sha256": "e5b6a1d2481f39c52a6012ec6b48a72e4618ff713f1927b6b0d6827a24b10ce7",
```

Measured digests: the **live ledger** at that path is `885201ed41b0b2d1eb142f3b67058442fb8a43dec16f09af76c9817c8e2dd02e`;
`e5b6a1d2…` is the digest of `qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json`.
**Which is right:** `spec_sha256` should name the file `spec_path` names. The value it carries is a
*correct* digest of a *different* file — the frozen as-authored snapshot, which is deliberately the
identity input (`deployment.inputs.trusted_local_acceptance_spec_sha256` = `e5b6a1d2…`, confirmed in
`frozen/FREEZE-RECORD.json`). So both digests are correct and the field pair is inconsistent. This is
the **same defect shape the lock already documents for `gate_spec_sha256`** (*"That digest is NOT
gate-spec.json's: it is acceptance-spec.json's"*), which makes it worth recording rather than
rounding away. It is a documentation defect: the lock's own note says no checker reads this field.

**(b) Two repo documents report the old 104-gate report as 85 PASS / 2 FAIL; the artifact says 84 / 3.**

- `qualification/gates.json` (the machine-readable report): `{PASS: 84, NOT_RUN: 10,
  BLOCKED_EXTERNAL: 1, FAIL: 3, NOT_APPLICABLE: 6}` — `FAIL` rows are `D10`, `E01`, `E06`.
- `qualification/gates-summary.json` (generated from it): `"PASS": 84, "FAIL": 3`.
- `qualification/results/MAIN-112-status/STATUS.md` line 17: *"85 PASS / 2 FAIL / 10 NOT_RUN / 1
  BLOCKED_EXTERNAL / 6 NOT_APPLICABLE"*.
- `docs/decisions/AUDIT-REQUEST-nosandbox.md`: *"| PASS | 85 | … | FAIL | 2（SEC-01、SEC-03…）"*.
- **Which is right: the artifact — 84 / 3.** The `85 / 2` figures are stale, and the `D10` row's own
  note says why: *"CORRECTED A SECOND TIME, AND THE CORRECTION REVERSES THE PREVIOUS ONE -- so this
  row is now FAIL rather than PASS … the guard existed when the note was written and has since been
  DELETED, and the row was never re-judged after the deletion -- so the PASS survived the mechanism
  it describes, which is the defect this whole report exists to catch."* A count of 85 PASS predates
  that correction. `gates-summary.json` and `gates.json` agree with each other and with the artifact.

**(c) `GAPS.md` says `ID-01`'s clause is CLOSED; the spec still records `ID-01` FAIL.**

- `docs/GAPS.md` `G-SEAM-47`: *"SUPERSEDED by `G-SEAM-74` — was: `OPEN`, `ID-01` FAIL on one source
  resolution out of 223. **The clause is CLOSED**: `artifacts.ts` now imports the public
  `@deepseek-ai/dsh-attachment` instead of the private `./src/store.ts` subpath, a real built-launcher
  boot resolves 221/221 under `lib/` with `sourceRows: []`, and `no-src-imports.test.ts` is the
  regression gate."*
- `qualification/specs/acceptance-spec.trusted-local-v1.json`: `ID-01` = `FAIL`, and it is `FAIL` on
  `cand-round3` too.
- **Which is right: the spec's `FAIL` is the status of record**, because it is the document bound to
  evidence at an identity, and because a prose row in `GAPS.md` is not a re-judgement. **I did not
  resolve this** — resolving it means re-measuring `ID-01` and re-judging the case, which is a
  measurement this slice did not perform and must not fake. Recording the disagreement is the honest
  act; the fix belongs to whoever owns `ID-01`.

**(d) THE LARGEST DIVERGENCE: five of the authority's 112 mandatory cases have been reclassified
out of scope by the repo's later spec, and one of them shares an id with a different case.**

This is not a documentation nit. The authority declares, verbatim, in `ACCEPTANCE.zh-CN.md` line 3:

> 全部门mandatory，初始均为NOT_RUN。本文件是测试规格，不是测试报告。
> ("All cases mandatory, initially all NOT_RUN. This file is a test specification, not a test
> report.")

and its machine-readable form agrees: **112 cases, all `mandatory: true`, all `NOT_RUN`, and the
strings `NOT_APPLICABLE` do not appear anywhere in either file** (`grep -c` returns **0** in both).

The repo's trusted-local spec then records five of those ids as out of scope. `SEC-01`, `SEC-03`,
`SEC-08`, `DEP-04` and `VER-04` are all **cases with `mandatory: true` in the authority spec**, and
all five appear in the trusted-local spec's `not_applicable_inherited` with
`new_status: "NOT_APPLICABLE"`:

| id | Authority (112) | Trusted-local (109) |
|---|---|---|
| `SEC-01` | case, mandatory, `NOT_RUN` | `not_applicable_inherited`, `NOT_APPLICABLE` |
| `SEC-03` | case, mandatory, `NOT_RUN` | `not_applicable_inherited`, `NOT_APPLICABLE` |
| `SEC-08` | case, mandatory, `NOT_RUN` | `not_applicable_inherited`, `NOT_APPLICABLE` |
| `DEP-04` | case, mandatory, `NOT_RUN` | `not_applicable_inherited`, `NOT_APPLICABLE` |
| `VER-04` | case, mandatory, `NOT_RUN` | `not_applicable_inherited`, `NOT_APPLICABLE` |

The trusted-local spec is explicit that these are not cases of its own spec:

> They are NOT cases of this spec: they are not in `cases`, they carry no status field, and no
> evidence may be filed against them. This section is a record of a decision, not a work queue.

and it gives the reasoning — which is sound on its own terms:

> FAIL means 'this architecture claims the invariant and did not achieve it'. Under trusted-local
> the OS user account is the execution authority boundary, so there is no isolation domain in which
> any of these five invariants could hold, and none is promised. Marking them FAIL would assert a
> claim this deployment does not make and cannot make; marking them PASS would assert an achievement
> that does not exist.

**Which is right — and why this matters more than the other divergences.** Both specs are internally
coherent, and the trusted-local reasoning is the honest description of what this deployment can
claim. But the authority is the document the acceptance criteria were issued under, and it provides
**no `NOT_APPLICABLE` status at all**. So a deployment that reclassifies five mandatory cases as
out-of-scope has changed the acceptance criteria it is being judged against, and it has done so in a
document (`acceptance-spec.trusted-local-v1.json`) that is *itself an identity input* of the lock.
That is not necessarily wrong — §4.2 records that the authority's `NOT_READY` verdict survives, and
the reclassification is argued rather than asserted — but **it is a change of standard, and it is
the delivery owner's to accept or reject, not the writer's.** I am recording it; I am not resolving
it, and I have changed neither spec.

**A second hazard in the same area: the id spaces collide, and the repo knows.** `VER-04` names two
different cases in the two specs. The trusted-local spec's own reasoning field flags this in its own
words:

> **Numbering warning: the old VER-04 and the new VER-04 are different cases; the new VER-04 is
> receipt freshness.**

That warning is correct and it is load-bearing: the trusted-local `VER-04` is **`PASS`** ("a receipt
does not outlive the tree it describes"), while the authority's `VER-04` ("verification-environment
privilege separation") is `NOT_RUN` and, per the repo, permanently unestablishable. A reader who
sees "`VER-04` PASS" without the spec's name beside it has read the opposite of the truth. The same
collision class applies to `SEC-01`, `SEC-03`, `SEC-08` and `DEP-04` for anyone quoting an id across
specs. **Any status quoted from this project must carry its spec's name; without it, four ids in this
repository are ambiguous and one of them is actively inverted.**

---

## 5. What this document did not do, and how to falsify it

**Did not do.** No code change. No verdict changed. No spec edited (`qualification/specs/` untouched).
No lock edited (`compatibility.lock.json` untouched, including the allowlist's condition — it still
reads `live_provider_budget_authorized: false`, re-read after the probes). No test suite run. No
network operation, install, paid API call, or budget-consuming run. Nothing pushed. `D:\DSH\src\dsh-src`
was read only, and only via `git rev-parse`. Both probes used temp copies outside the repo and
deleted them; the probe outputs in §2.3 include the confirmation that the repo files were untouched.
`qualification/results/C9-coverage/COVERAGE.md` did not exist at the time of writing (checked twice),
so the full 112-case inventory is not duplicated here — this document is the register and the
readiness statement only.

**Falsify it.** Every claim above is a command or a quoted line. The four that carry the most weight:

1. `python qualification/runners/release-gate.py` — must print `RELEASE=NOT_READY blockers=4`, the
   four blockers quoted in §0.1, and `[ok]` on check 8.
2. `python qualification/runners/verify-spec.py` — must print `problems=317`, and the 317 decompose
   into exactly 314 identity-mismatch + 3 digest-mismatch with nothing left over.
3. `python helpers/rederive-identity.py` — must print the two moved inputs and the recomputed
   identity `152e5c45…`.
4. `git archive cand-round3 | tar -x -C <tmp> && cd <tmp> && python qualification/runners/release-gate.py`
   — must print `blockers=1` with `FAIL=9, PASS=99`, which is the state this task's brief described
   and which does **not** describe `wt/c12`.

**The one sentence a hostile auditor should hold this document to.** *On `wt/c12` at `93f88ba` the
release gate says `NOT_READY` for four named reasons plus one unnamed failing check; exactly one case
is externally blocked and sanctioned by an allowlist that re-checks its own condition on every run;
thirteen mandatory cases are `FAIL` and are not blocked on anything external; the remaining
`NOT_RUN` population is unattempted, not blocked; and no mock, control, or partial result in this
repository has been presented here as a real result.*
