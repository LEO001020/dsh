# R10-security — SEC-01..08 re-derivation, closability, and oracle audit

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Repo:** `D:\DSH\work\dsh-native-daily` @ `a1d6e6decedb4f8f2d7b218ba82a22976a0b95c2` (branch `ipython-native`, NOT committed)
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` — unmodified
**Runner selected:** `windows-acl` (the sole `win32` candidate), `enforcement: partial`

**Evidence in this directory**
- `tests.txt` — `vitest run src/sec-gates.test.ts src/security.test.ts src/security-denial.test.ts` → **70 passed (3 files)**, exit 0
- `probe-seams.mjs` / `probe-seams.txt` — raw seam probe, exit 0 (see §2)
- `tsc-build.txt`, `tsc-check.txt` — both typecheck configs, exit 0
- `source-digests.txt` — sha256 of every file this task touched

**Scope note.** Every finding below was re-derived from the pinned checkout's source
and re-measured on this host. Nothing is inherited from
`qualification/results/M-DEP-SEC-UPG/UPG-08-verdict.txt` or from
`docs/GAPS.md` without a fresh source quote and a fresh measurement. Where the
earlier record and the source disagree, the disagreement is reported.

---

## 1. Verdict table

| Gate | Status | What this pass established |
|---|---|---|
| SEC-01 host credential isolation | **FAIL** (unchanged, sharpened) | Re-derived: the boundary is writes only, at three independent levels (seam type, backend mechanism, profile builders). **Closability now MEASURED, not argued** — four candidate levers probed, none restricts a read. |
| SEC-02 control-plane isolation | **PASS** (verified) | The measurement is a real catalog scan with a non-vacuous control (27 tools present, 23 surfaces checked, 0 exposed). Assertions match their claims. |
| SEC-03 network/egress | **FAIL** (unchanged, sharpened) | Re-derived: network is excluded from the seam's vocabulary in its own words. **Closability MEASURED** — the `runnerCommand` override is a real public seam and still cannot carry a network policy. |
| SEC-04 address policy | **PASS** (verified) | Real HTTP server, real redirect refusals, real pinned-lookup call. The redirect test stubs the address guard but measures that guard separately, and says so. |
| SEC-05 symlink escape | **PASS** (verified) | Refusal asserted at the canonical-target boundary with a byte-identity check and an inside-write control. The hardlink half is honestly split into two measured halves. |
| SEC-06 capability epoch | **FAIL** (unchanged, sharpened) | G-SEAM-21 **confirmed by independent scan**, plus a second half the record did not state: the epoch is never *bumped*, so the guard's precondition is unreachable twice over. |
| SEC-07 cell isolation claims | **PASS** (verified) | The claim-absence scan is over project sources and matches no true positive; the transport limit and the unconfined kernel spawn are both measured. |
| SEC-08 per-read-permission execution world | **NOT_RUN** (status CORRECTED) | Genuinely `NOT_RUN`, **not** `BLOCKED_EXTERNAL`. A test title in `sec-gates.test.ts` claimed `BLOCKED_EXTERNAL` while the verdict table recorded `NOT_RUN`; the title was corrected, not the status. |

**No gate was turned green. No gate was narrowed. Two FAILs remain FAIL and one
status was corrected in the *stricter* direction.**

---

## 2. SEC-01 / SEC-03 — the enforcement seam, quoted

### 2.1 The seam's own vocabulary excludes reads and network

`packages/sandbox/sandbox/src/index.ts:24-29` — the mode type and its doc:

```
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * backend-defined temp area; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

`packages/sandbox/sandbox/src/index.ts:39-43` — what the policy carries. Three
fields, none of them a read or network lever:

```ts
export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
```

`packages/sandbox/sandbox/src/index.ts:69-72` — `SandboxPolicy` narrows the mode
and adds nothing:

```ts
export interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}
```

`packages/sandbox/sandbox/src/index.ts:32` — `danger-full-access` is not even a
policy the seam can carry:

```ts
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

`packages/sandbox/sandbox/src/index.ts:95` — `ConfinedArgv`'s complete field set,
measured rather than grepped (probe §1): `argv`, `enforcement`,
`denialSignatures`, `runnerFailureRules`. **No read, network, egress, proxy or
dns field.** A caller cannot even *observe* a read denial.

`packages/sandbox/sandbox/README.md:167` — the limit stated as a design boundary:

```
- **File effects are the whole policy vocabulary** — the seam expresses no network, process, syscall, device, or credential restrictions.
```

### 2.2 The Windows backend states it in its own header

`packages/sandbox/sandbox-windows-acl/src/index.ts:23-25`:

```
 * Known boundaries (inherent to restricted tokens, not this port):
 *  - writes are restricted; reads, network, and process visibility are NOT
 *    (WRITE_RESTRICTED intersects only write accesses);
```

The mechanism, `packages/sandbox/sandbox-windows-acl/src/token.ts:210-214` — the
`WRITE_RESTRICTED` flag is the whole read story, and there is no `SidsToDisable`
list that could turn a SID deny-only:

```ts
  const created = api.createRestrictedToken(
    currentToken,
    abi.DISABLE_MAX_PRIVILEGE | abi.LUA_TOKEN | abi.WRITE_RESTRICTED,
    0, null, // no SIDs disabled
    0, null, // no privileges deleted
```

`packages/sandbox/sandbox-windows-acl/README.md:116`:

```
- **Writes are restricted; reads, network, and process visibility are not** — `WRITE_RESTRICTED` intersects write accesses only, so a confined child can read any caller-readable file and open sockets; `read-only` therefore needs a read-side policy to be expressed.
```

`packages/sandbox/sandbox-windows-acl/README.md:175` — the package names its own
requirement as out of scope:

```
- **Read-side confinement and network policy are out of scope** — `WRITE_RESTRICTED` intersects write accesses only; pair this backend with a read-side policy for stronger confinement.
```

The upstream design note
(`.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md`)
records *why* the read-capable primitive was rejected, which closes the "was this
just an oversight" question:

> The same primitive could restrict reads (`SidsToDisable` turning SIDs
> deny-only), but a read-restricted token would need per-path read grants —
> reintroducing exactly the cost the identity routes pay — and the sandbox
> vocabulary never requires read confinement.

### 2.3 It is a SEAM fact, not a Windows fact

`packages/sandbox/sandbox-local/src/profiles.ts:16-23` — the bwrap profile mounts
the whole host **read-only**, so reads succeed and writes get EROFS:

```ts
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
  }
  return args
}
```

`--unshare-pid` is present and `--unshare-net` is absent (probe §5 asserts the
complete flag set: `--bind, --dev, --die-with-parent, --proc, --ro-bind, --tmpfs,
--unshare-pid`). The Landlock builder grants `readOnly: ['/']` and the Seatbelt
profile is `(allow default) + (deny file-write*)` — all four backends are
write-only by construction, so a deployment move cannot close SEC-01/03.

`packages/fs/fs-sandbox/src/index.ts:7` and `:10-11` — the in-process fs fence
does not touch reads either, and says so twice:

```
 * on the two mutations. Reads pass through untouched: every mode permits
 ...
 * The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
 * NOT a kernel boundary — the operations are the seam's own (open, rename),
```

Measured (probe §5): the only fenced (overridden) methods are `writeText` and
`editText`. **Zero fenced read methods.**

### 2.4 CLOSABILITY — measured, because "no lever in the type" is not enough

A FAIL is only a complete answer if the seam cannot express the requirement.
`probe-seams.mjs` probes the four candidate levers a previous pass could have
missed. Reproduce with `node qualification/results/R10-security/probe-seams.mjs`.

**Lever 1 — a different `mode` changes read behaviour?** No.

```
mode=read-only        exit=0 enforcement=partial -> READ_OK:CANARY-FAKE-R10-READ-NOT-A-CREDENTIAL
mode=workspace-write  exit=0 enforcement=partial -> READ_OK:CANARY-FAKE-R10-READ-NOT-A-CREDENTIAL
```

Both confined modes read a canary **outside** the workspace root verbatim, exit 0.
`danger-full-access` cannot reach `confine()` at all — it is excluded from
`ConfinedSandboxMode` and short-circuited by the consumer
(`packages/shell/bash-sandbox/src/index.ts:92`, matched in-test:
`if (mode === 'danger-full-access') { const result = await super.run(spec)`).
So there is no mode, and no path to a mode, that restricts a read.

**Lever 2 — a read/network flag smuggled through the runner argv?** No; refused.

The runner's parser has a closed switch (`runner.ts:92-100`) with exactly
`--workspace`, `--temp`, `--mode`, `--write-sid`, `--temp-write-sid`, and
`default: fail(\`unknown argument: ${token}\`)`. Measured against the **real built
runner** with four plausible flags:

```
argv ["--deny-net"]             exit=127 refused=true stderr=windows-acl-run: unknown argument: --deny-net
argv ["--read-only-fs","/"]     exit=127 refused=true stderr=windows-acl-run: unknown argument: --read-only-fs
argv ["--no-network"]           exit=127 refused=true stderr=windows-acl-run: unknown argument: --no-network
```

Exit 127 and `RAN` never printed: the flag is refused rather than silently
ignored, which is what makes "no read flag exists" trustworthy.

**Lever 3 — the `runnerCommand` override?** Real, public, and still file-effect only.

This is the one genuinely worth checking, because it is a documented public
config seam (`packages/sandbox/sandbox-local/src/index.ts:320-327`) through which
an operator supplies the runner — and a container-style runner *could* carry a
network namespace. What it cannot do is *express* one:

```ts
    if (this.runnerCommand !== undefined) {
      return Promise.resolve<ConfinedArgv>({
        argv: [...this.runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv],
        enforcement: 'full',
```

The override supplies only the **program**; the profile arguments are still
produced by `bwrapProfileArgs(policy)`, and the `SandboxPolicy` they are built
from has no network field to carry a policy. On win32 the platform chain has
exactly one candidate (`sandbox-local/src/index.ts:165`, `win32:
['windows-acl']`), so there is not even a second runner to select. And the
override is documented as an unprobed **operator assertion**
(`sandbox-local/README.md`): *"a configured custom runner skips functional
probes and is assumed to implement the bwrap-compatible profile honestly"* — so
it cannot be presented as a verified control in any case.

**Conclusion for lever 3:** using it for reads/egress would mean *shipping a new
OS-level read/network-confining runner*, i.e. adding a mechanism this deployment
does not have — not using a seam that exists. That is a different task with a
different status, and calling it "closing SEC-01 through a public seam" would
misstate what was built.

**Lever 4 — a read fence in the fs seam?** No (see §2.3).

### 2.5 What remains open, and precisely why the seam cannot express it

| Requirement | Why no public seam can express it |
|---|---|
| SEC-01: `HOME`/`DSH_HOME`/`proc` unreachable by a read | `SandboxPolicy` carries `mode` + `workspaceRoot` (+ `sessionId`) and nothing else. `ConfinedSandboxMode` excludes the only non-confining mode. Every backend is built from a write-only mechanism (`WRITE_RESTRICTED`, `--ro-bind`, `readOnly: ['/']`, `deny file-write*`). `ConfinedArgv` has no field in which a read denial could be reported. |
| SEC-03: unauthorized direct connections blocked by OS/gateway | The seam's own README states network is outside its vocabulary. The runner argv refuses unknown flags. The only egress-adjacent service (`http-proxy`) is a **client-side** proxy for the harness's *own* outbound calls — it governs undici in this process, while a confined child reaches the network through the OS — and its own `LOOPBACK_NO_PROXY` forces loopback around the proxy, so it could not be an egress boundary even in-process. |

Both are therefore **honest FAILs with a structural cause**, which is a complete
answer. Closing them requires new OS-level infrastructure (a read-confining
runner, a container/VM/network namespace), not a change in this project's code.

---

## 3. SEC-06 — G-SEAM-21 confirmed, and sharpened

### 3.1 Confirmation (independent scan over `packages/dsh-daily-work`)

| Claim | Result |
|---|---|
| `recovery.ts` has no non-test importer | **CONFIRMED.** `grep -rn "from './recovery.ts'"` over `src/*.ts` matches exactly one file: `durability-records.test.ts:57`. The built `lib/` tree agrees — `lib/recovery.js` exists and **no** `lib/*.js` imports it. |
| `applyWorkerSettlement` has no caller outside its module and its test | **CONFIRMED.** Definitions/usages: `recovery.ts:254` (def), `durability-records.test.ts:1640,1715,1733` (calls), and comments in `record.ts` / `sec-gates.test.ts`. No production caller. |
| Nothing reads or writes `record.epoch` after `initialRunRecord` sets it to 1 | **CONFIRMED, and stronger than recorded.** `.epoch` appears in production only in `recovery.ts:274,276,396,400` (the guard and its refusal ledger). Every other `epoch` hit in the package is `kernelEpoch`/`kernel_epoch` in the unrelated kernel plane. |

### 3.2 The sharpening: the unreachability is DOUBLE

The GAPS entry says the guard is unreachable. It does not say that **wiring it
alone would still refuse nothing**, and that is the more useful finding. Across
all production sources the `epoch` field is written in exactly **one** place —
`record.ts:493`, `epoch: 1` inside `initialRunRecord` — and the production
re-adoption path does not touch it:

```ts
  async resume(runId: string, now = new Date().toISOString()): Promise<RunRecord> {
    return this.mutate(runId, record => ({
      ...record,
      phase: record.phase === 'paused' ? 'open' : record.phase,
      updatedAt: now,
    }))
  }
```

Measured in-test: no `epoch` expression in that method body, and no production
file outside `record.ts`/`recovery.ts` assigns or compares `epoch`. So
`applyWorkerSettlement` would evaluate `1 !== 1` and accept every settlement.
The value the guard exists to refuse — a settlement from a previous host
generation — **is a value no code in this package can currently produce.**

### 3.3 What the missing enforcement would actually let through

Stated concretely, because "the field is inert" undersells it:

1. Host A admits a task under epoch 1 and launches a child.
2. Host A dies; the run is re-adopted by host B — a **new generation** holding the
   same store (`resume()` above does not bump the epoch, and nothing else does).
3. The stale worker, or a late settlement from A's child, submits
   `{ runId, taskId, childId, to: 'confirmed' }`.
4. With no enforcement, the remaining checks are the task's existence and the
   `childId` match — and `childId` is a **string** that a resumed or re-launched
   child can legitimately carry (`tool-protocol-guards.ts` records exactly this
   limit: *"an id survives a replacement, an object does not"*).
5. The settlement is **applied**. The task moves to a terminal state and its
   reservation is **released**, in a generation that never admitted it.

The concrete damage is budget authority: in `WorkService.transition`
(`host.ts:900`), `release` is what frees the slot
(`input.to === 'confirmed' || input.to === 'cancelled'`) and `spentCost` is what
attributes cost. A stale confirmation can therefore **free a slot the new
generation believes is occupied and attribute spend to a generation that did not
incur it** — and it bypasses `assertTransition`'s protection only insofar as the
task is in a state that admits the transition, which a re-adopted run's
`executing` task is. This is the "旧执行权限失效" clause of SEC-06's oracle going
unmet **by the record path alone**, before the kernel half is considered.

### 3.4 The minimal honest fix (recorded, deliberately NOT applied)

Both halves are required, and either alone is insufficient:

1. **Bump the epoch** on the one path that actually re-adopts a run —
   `WorkService.resume`, or whatever path a re-adopting host uses. Without this,
   the guard compares `1` to `1` forever.
2. **Route every settlement** through `applyWorkerSettlement` instead of
   `WorkService.transition`. Without this, the guard stays unimported.

Not applied here, and the reason is the recorded one: `recovery.ts` is outside
this task's ownership, and there is no production settlement-receiving path to
connect to — wiring one would *invent a caller rather than connect a real one*,
which would convert an honest FAIL into an untested green. The status stays FAIL.

---

## 4. SEC-08 — NOT_RUN, not BLOCKED_EXTERNAL

**Determination: genuinely `NOT_RUN`.** The distinction matters for the promotion
verdict, and the two statuses are not interchangeable
(`docs/DELIVERY.md`):

| Status | Means |
|---|---|
| `NOT_RUN` | Not exercised. **Includes `PARTIAL`.** Not a soft pass. |
| `BLOCKED_EXTERNAL` | The remaining work needs an **authorization** this machine does not have. |

SEC-08's remaining work needs a second provisioned **execution world**, which is
infrastructure rather than authorization, and its mechanism is
present-but-unwired rather than awaiting permission. `BLOCKED_EXTERNAL` in this
project is reserved for exactly one case — the live-provider budget
(`UPG-07`, `live_provider_budget_authorized: false`) — and `upg-gates.test.ts`
pins that set to `['UPG-07']`.

Three measurements support `NOT_RUN`:

1. **The kernel half HOLDS.** `packages/dsh-ipython/src/kernel-plugin.ts`
   re-checks identity on every resolve and throws on a changed execution world
   rather than silently replacing the kernel:
   `existing.identity.executionWorld !== identity.executionWorld`,
   `existing.identity.environmentDigest !== identity.environmentDigest`.
2. **The migration half exists but has no runtime.** `changeReadPermissionDomain`
   is implemented correctly in `packages/dsh-daily-work/src/kernel-lifecycle.ts`
   (close admission → cancel and clean up → new epoch; `kernelEpoch:
   previousEpoch + 1`) and has **no production importer** — re-measured by scan,
   and the package does not export it.
3. **No second world exists to migrate to.** `packages/dsh-ipython/cordis.patch.yml`
   sets `executionWorld: local`; the daily composition mounts no
   docker/podman/wsl/ssh execution world. The architecture requires one
   (*"其他项目或不同读权限域使用独立execution world/VM"*), so the cross-world half is a
   provisioning fact rather than a missing fixture — and per the acceptance spec
   a simulated world would not substitute.

### 4.1 Status inconsistency found and corrected (in the stricter direction)

`sec-gates.test.ts` contained a test titled
`'the gate is BLOCKED_EXTERNAL, and the reason is that no second execution world exists to migrate to'`
while `upg-gates.test.ts` — the verdict table that actually produces the
promotion decision — records `{ id: 'SEC-08', status: 'NOT_RUN', ... }`. The test
body never asserted `BLOCKED_EXTERNAL`, so the contradiction lived only in the
title; a reader grepping for the status would have found the wrong one.

**Fix applied:** the title and the section comment now say `NOT_RUN`, and the
test *asserts* the distinction rather than describing it — it pins the
`upg-gates` row to `NOT_RUN`, pins the `NOT_RUN` set to
`['DEP-04', 'SEC-08', 'UPG-08']`, pins `BLOCKED_EXTERNAL` to `['UPG-07']`, and
quotes both status definitions from `docs/DELIVERY.md`. The claim was not
weakened; the mislabel was removed.

---

## 5. The PASSes — oracle audit

The failure mode this project keeps hitting is **an oracle weaker than its
scenario**. Each PASS was re-run and spot-checked against its own claim.

| Gate | Is the oracle as strong as the claim? | Evidence |
|---|---|---|
| SEC-02 | **Yes.** The load-bearing half is a real catalog scan with a non-vacuous control: 27 tools present (including this project's own `work`, so the composition is the daily one), 23 declared surfaces checked individually, **0** exposed, and the 4 that never resolved are the *same 4* the readiness wait reported missing — which distinguishes "not mounted" from "probe did not wait". The in-repo half additionally asserts an **empty** catalog (`sec-gates.test.ts`, "the tool registry refuses an unknown name before any pipeline runs": `expect(ctx.tools.schemas(ctx)).toEqual([])`) so "unknown tool" cannot be an artefact of the fixture, and pins the tool-surface name set exactly (`security.test.ts`: `expect(names.sort()).toEqual([...OUR_TOOLS].sort())`), which an earlier version did not. | `M9.19-control-plane/FINDINGS.md:64-78`; `sec-gates.test.ts` SEC-02; `security.test.ts` |
| SEC-04 | **Yes.** Measured against a real HTTP server: a same-origin redirect IS followed, a cross-origin one is refused **and the attacker's host is never contacted** (`hits` does not contain `/steal`), a credentialed redirect is refused, a `file:` redirect is refused, and the hop budget is bounded. The `createPinnedLookup` assertion is not structural-only — the lookup is **called** and must answer from the fixed set. The redirect test stubs the address guard, and says so, because that guard is measured separately against the real resolver. | `sec-gates.test.ts` SEC-04 |
| SEC-05 | **Yes**, and notably honest. The symlink refusal is asserted with `FS_SANDBOX_DENIED`, a byte-identity check on the outside file, and an inside-write control proving the fence is alive. The hardlink vector is measured and reported as **two halves** — the fence does *not* refuse, and the outside name survives only because the atomic rename severs the link — rather than collapsed into a green. The fixture's own earlier measurement error (using `os.tmpdir()`, which `workspace-write` grants) is recorded in the test. | `sec-gates.test.ts` SEC-05 |
| SEC-07 | **Yes.** The claim-absence scan runs over all project `.ts` sources against four phrasings a claim would use; re-run and it matches nothing (the only hits in the tree are the patterns' own definitions). The transport limit is cited from a measurement file, and the "OS identity is a pid, not a confinement" test **measures** that the ipython plane never calls `ctx.sandbox.confine` — closing the reading that would let "separate process with its own OS identity" be overread. | `sec-gates.test.ts` SEC-07 |

**Strengthened during this pass** (oracle raised, claim unchanged):
- `security.test.ts` — the tool-surface test now asserts the **exact** name set
  (`toEqual(['work'])`) instead of only the absence of six forbidden names. The
  old form would have passed just as well if the plugin had registered
  `terminal_exec` or `admin_rpc`. (Change was already present in the working tree
  when this pass began; verified and retained.)
- `sec-gates.test.ts` — the SEC-01 seam test's read-lever absence is now
  corroborated by an **end-to-end measurement** (§2.4) rather than by type
  declarations alone.
- `sec-gates.test.ts` — SEC-06's reachability test now also asserts that **no
  production file writes `epoch`** and that `resume()` does not, establishing the
  double unreachability (§3.2).

### 5.1 Mutation check — the new oracles actually bite

To confirm the added assertions are not decorative, a mutation was injected into
the runner-case assertion (`'--deny-net'` added to the expected case list, i.e.
simulating a runner that *would* accept a network flag):

```
× SEC-01 > CLOSABILITY: every candidate read lever is measured and none restricts a read
  → expected [ '--mode', '--temp', …(3) ] to deeply equal [ '--mode', '--temp', …(4) ]
  Tests  1 failed | 1 passed | 45 skipped
```

The mutation was reverted immediately and the file's digest re-verified
(`08f45e81…`, see `source-digests.txt`). The oracle fails when the claim changes.

---

## 6. What is NOT proven

Stated explicitly, because each of these is a place where a reader could
mistake the record for something stronger:

1. **No read confinement was achieved, and none is claimed.** SEC-01 remains FAIL.
   A confined child reads any caller-readable file under both confined modes.
2. **No egress control was achieved, and none is claimed.** SEC-03 remains FAIL.
   A confined child completes real HTTP round trips to loopback and connects to a
   LAN address under the strictest mode.
3. **The `runnerCommand` seam was analysed, not exercised end-to-end.** The
   conclusion that it cannot carry a network policy is from its call shape
   (`[...runnerCommand, ...bwrapProfileArgs(policy), '--', ...argv]`) and from the
   win32 chain having one candidate. No custom read/network-confining runner was
   written, because writing one would be new infrastructure rather than a seam
   test — and claiming a PASS from it would be the exact defect this task exists
   to avoid.
4. **SEC-06's fix is specified, not implemented.** No epoch bump and no
   settlement routing was wired. The guard still refuses nothing.
5. **The cloud-metadata probe (169.254.169.254) does not connect on this host.**
   That is a property of this machine's routing table, **not** a control — the
   test asserts `ERR|TIMEOUT` and separately asserts that the seam carries no
   network fact. Do not read that one non-connection as partial egress defence.
6. **The POSIX measurements depend on WSL + bwrap being present.** They ran and
   passed here (real round trip inside the exact `read-only` profile, DNS exit 0).
   On a host without them the tests report SKIP with the reason rather than
   passing silently.
7. **SEC-02's control-plane result is a measurement of the composition under
   test**, not a proof about every possible composition. It holds for the daily
   profile that was measured (27 tools present).
8. **SEC-08 is unexercised, not impossible.** The kernel half holds; the migration
   half is unwired; the second execution world does not exist. Whether the design
   is *correct* for a two-world deployment is untested.
9. **This pass did not run the whole suite.** Only the three owned test files were
   run, per the constraint that other agents are working in this tree
   concurrently. Their status is not reported here.
10. **Nothing was committed.** The tree is left modified on `ipython-native`.

---

## 7. Rows to add to `docs/GAPS.md` (NOT applied — this file's owner owns it)

`docs/GAPS.md` was **not edited** — its owner is actively editing it (it grew from
G-SEAM-21 to G-SEAM-27 and gained G-VER-01..04 while this pass ran), so the rows
below use the next FREE ids in their namespaces as of this writing and the owner
should re-check them before pasting. Note that G-VER-03, added by that other
agent, independently reaches the same SEC-01/03 conclusion from the same source
(`SandboxPolicy` has no read or egress lever; `WRITE_RESTRICTED` intersects writes
only) — two independent passes agreeing is worth recording as such.

These are the exact rows, matching the file's column shape
(`| ID | Gap | Status | Note |`) and its status vocabulary
(`OPEN` / `IN_PROGRESS` / `RESOLVED` / `BLOCKED_EXTERNAL` / `NOT_APPLICABLE`):

```markdown
| G-SEAM-12 | Windows sandbox is real but write-only and `enforcement: 'partial'`. | **CONFIRMED BY MEASUREMENT — CLOSABILITY RE-VERIFIED** | A confined child **read** a canary secret outside the workspace root successfully, verbatim, under both `read-only` and `workspace-write` (exit 0). Writes outside are `EPERM` in both modes. `WRITE_RESTRICTED` intersects only write accesses, and `SandboxPolicy` is only `mode` + `workspaceRoot`, so the seam has no read lever even in principle. Network egress is uncontrolled for bash/pwsh/subprocess/PTC; only `web_fetch` has SSRF filtering, which filters that tool's URL and is bypassed by any shell command. **Closability is now measured rather than argued** (R10-security `probe-seams.mjs`): every mode the seam can carry reads outside verbatim; the windows-acl runner refuses unknown argv with exit 127 (probed against the REAL built runner with `--deny-net`, `--read-only-fs`, `--no-network`); the `runnerCommand` override can only substitute a runner for the SAME bwrap-compatible file-effect profile (`sandbox-local/src/index.ts:320-327`) and is an unprobed operator assertion, and the win32 chain has exactly one candidate (`index.ts:165`) — so no public seam expresses read or network policy. Closing either needs new OS-level infrastructure (a read-confining runner, a container/VM/network namespace), not a code change here. Evidence: `qualification/results/M9.3-security-denial/`, `qualification/results/R10-security/`. |

| G-SEAM-28 | **The run-record `epoch` is never BUMPED, so wiring the guard alone would still refuse nothing.** | OPEN — second half of G-SEAM-21 | G-SEAM-21 records that `applyWorkerSettlement` is unreachable. This is the other half: even if it were imported, its precondition cannot occur. Across all production sources the `epoch` field is written in exactly ONE place — `record.ts:493`, `epoch: 1` inside `initialRunRecord` — and the production re-adoption path (`WorkService.resume`, `host.ts:707-713`) re-opens the phase WITHOUT touching it. So the guard would evaluate `1 !== 1` and accept every settlement; the value it exists to refuse (a settlement from a previous host generation) is a value no code in this package can produce. **Concrete consequence if left open**: host A admits a task under epoch 1, dies, and host B re-adopts the run; a late settlement from A's child passes the `childId` string match and is applied, moving the task terminal and RELEASING its reservation in a generation that never admitted it — freeing a slot the new generation believes is occupied and attributing spend to the wrong generation (`WorkService.transition`, `host.ts:900`). **Minimal honest fix, both halves required**: bump the epoch on the real re-adoption path, AND route settlements through `applyWorkerSettlement` instead of `WorkService.transition`. Not wired, deliberately: no production settlement-receiving path exists, so wiring one would invent a caller rather than connect a real one. Evidence: `qualification/results/R10-security/FINDINGS.md` §3. |

| G-VER-05 | A test title in `sec-gates.test.ts` asserted `SEC-08` is `BLOCKED_EXTERNAL` while the verdict table records `NOT_RUN`. | RESOLVED — recording corrected in the stricter direction | The two statuses are not interchangeable: `BLOCKED_EXTERNAL` means the remaining work needs an AUTHORIZATION this machine does not have, while `NOT_RUN` means not exercised. SEC-08 needs a second provisioned execution world (infrastructure) and its mechanism is present-but-unwired, so `NOT_RUN` is correct. The title and section comment now say `NOT_RUN`, and the test asserts the distinction — pinning the `upg-gates` row, the `NOT_RUN` set `['DEP-04','SEC-08','UPG-08']`, the `BLOCKED_EXTERNAL` set `['UPG-07']`, and both status definitions from `docs/DELIVERY.md`. Evidence: `qualification/results/R10-security/FINDINGS.md` §4.1. |
```

---

## 8. Commands run, with exit codes

```bash
# tests — the three owned files only
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"
npx vitest run src/sec-gates.test.ts src/security.test.ts src/security-denial.test.ts
# → Test Files 3 passed (3) · Tests 70 passed (70) · exit 0   (evidence: tests.txt)

# typechecks
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # → exit 0
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json      # → exit 0

# raw seam probe
node qualification/results/R10-security/probe-seams.mjs                            # → exit 0
```

**A transient cross-agent typecheck conflict, recorded because it was real and
because the resolution is not obvious from the final green.** While this pass ran,
the shared `tsconfig.check.json` exited **2** on two files this task does not own —
`src/data-plane.test.ts` and `src/research-chain.test.ts` — which other agents were
editing at that moment (both were rewritten between 03:25 and 03:26, after this
pass's files were final). Two of the three errors were theirs directly; the third
(`packages/fs/tool-fs/src/sandbox.ts(43,15)`) was a **transitive** consequence of
`data-plane.test.ts`'s deliberate deep import of `@deepseek-ai/dsh-tool-fs/src/index.ts`,
which pulls that checkout file into the program. This pass's files were never in
the error list (verified by grep, 0 hits), and both configs exited **0** again once
those agents' edits settled.

`tsconfig.attribution.json` in this directory preserves the method, so the
attribution can be re-checked rather than taken on trust: it extends the real check
config with identical strict flags and excludes only those two foreign files. It
exited **0** while the shared config exited 2, which is what proved the errors were
not this pass's. It is an attribution probe, **not** a gate config — it must never
be substituted for `tsconfig.check.json` in a verdict, because excluding a file is
exactly the "false pass" that DEP-03 exists to catch.

Pinned-checkout integrity: `git -C /d/DSH/src/dsh-src rev-parse HEAD` →
`ddefc45fbc7f8e46dd73185e68295696d1297887`, unmodified. No credential was read;
every canary in the fixtures and in the new tests is a fabricated
`CANARY-FAKE-*` value.

**Commit attribution, recorded because it affects how a reader reads the history.**
This pass made **no commit and no push** (`git commit`/`git push` were never run
here). During the pass, a *different* agent working in the same tree ran
`git commit`, producing `1e0b8d69` ("R10 security re-derivation: FAILs
sharpened, SEC-08 corrected stricter"), whose message describes this pass's work
and which swept in this pass's in-flight files along with many other agents'
evidence directories. The working tree is the source of truth for this report:
the digests in `source-digests.txt` are of the **on-disk** files, and
`sec-gates.test.ts` is still untracked (`git ls-files` does not know it) because
the committing agent did not add it. `FINDINGS.md` was edited *after* that commit
(the free-id correction in §7), so its committed and on-disk contents differ; the
digest file records the on-disk content.
