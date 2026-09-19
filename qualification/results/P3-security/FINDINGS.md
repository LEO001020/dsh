# P3 — the security gate family: re-derivation, closure, and what stays open

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)
**Runner selected on this host:** `windows-acl` (the sole `win32` candidate), `enforcement: 'partial'`
**Owned files touched:** `src/sec-gates.test.ts`, `src/security.test.ts`, `src/security-denial.test.ts`

## Verdict table

| Gate | Was | Now | Why |
|---|---|---|---|
| SEC-01 host credential isolation | FAIL | **FAIL** | Re-derived from source and re-measured on TWO platforms. The boundary is a WRITE boundary in the seam's own vocabulary, not just on Windows. No public seam can express the requirement. |
| SEC-02 control-plane bypass | PASS | **PASS** (test strengthened) | The oracle was weaker than its own title; the count is now asserted, not implied. |
| SEC-03 network/egress | FAIL | **FAIL** | Re-derived and re-measured. No egress vocabulary exists in any backend; the bwrap profile carries `--unshare-pid` and NOT `--unshare-net`. |
| SEC-04 SSRF | PASS | **PASS** | Re-run; assertions match their claims. The guard is real and is a TOOL-level filter. |
| SEC-05 path race | PASS | **PASS** (coverage widened) | The oracle names symlink/hardlink/rename; only symlink was covered. Hardlink is now measured on both paths. |
| SEC-06 capability epoch | FAIL | **FAIL** (finding sharpened) | G-SEAM-21 CONFIRMED by independent import-graph scan. A **second, previously unrecorded instance** of the same defect found in `host.ts`. |
| SEC-07 same-kernel thread | PASS | **PASS** (one claim pinned) | The "own OS identity" claim is a pid, not a confinement; now asserted so it cannot be overread. |
| SEC-08 per-read-permission execution world | NOT_RUN | **BLOCKED_EXTERNAL** | Reclassified with the reason. The kernel half HOLDS and is measured; the migration half exists but is unreachable; the cross-world half needs provisioning this host does not have. |

**No gate was turned green by narrowing it.** SEC-01, SEC-03 and SEC-06 remain FAIL with sharper evidence; SEC-08 moved from NOT_RUN to BLOCKED_EXTERNAL, which is a *worse* status for promotion (a named external blocker, not an unbuilt fixture).

---

## SEC-01 — host credential isolation: FAIL, and the seam cannot express it

### The enforcement seam, quoted

The whole policy a caller can express:

- `packages/sandbox/sandbox/src/index.ts:24` —
  *"File-effect policy for confined processes. `read-only` permits only required sinks such as `/dev/null`; `workspace-write` also permits the workspace and a backend-defined temp area; `danger-full-access` bypasses confinement. **Network and process visibility are outside this vocabulary.**"*
- `packages/sandbox/sandbox/src/index.ts:39-52` — `SandboxExecutionPolicy` carries exactly `mode`, `workspaceRoot`, `sessionId?`. No read field.
- `packages/sandbox/sandbox/src/index.ts:69-72` — `SandboxPolicy extends SandboxExecutionPolicy` adds exactly one thing: `mode: ConfinedSandboxMode` (a *narrowed* mode).
- `packages/sandbox/sandbox/src/index.ts:95-116` — `ConfinedArgv` carries `argv`, `enforcement`, `denialSignatures`, `runnerFailureRules`. There is no field in which a read denial could even be *reported*.

**So there is no read lever even in principle, and that is a property of the type, not of a backend.**

### The Windows backend's own header, quoted

`packages/sandbox/sandbox-windows-acl/src/index.ts:24-25`:

> *"Known boundaries (inherent to restricted tokens, not this port):*
> *  - **writes are restricted; reads, network, and process visibility are NOT**
> *    (**WRITE_RESTRICTED intersects only write accesses**);"*

`packages/sandbox/sandbox-windows-acl/src/token.ts:164-165` gives the mechanism:

> *  - read-only:       [logon SID, EVERYONE]
>  - workspace-write: [logon SID, EVERYONE, workspace SID, optional temp SID]*

`token.ts:212` passes `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`. The README states the selection rule plainly: *"Choose a different mechanism when the child must also be read-confined or network-restricted"* and lists *"Read-side confinement and network policy are out of scope"*.

### Is there a public seam the earlier agents missed? MEASURED: no — and this is cross-platform

Four candidate seams were checked, and each was measured rather than reasoned about:

| Candidate | Verdict | Evidence |
|---|---|---|
| A stricter `mode` | **Does not exist.** The vocabulary is a closed union of three, and `read-only` is already the strictest. `read-only` permits reads by construction (`--ro-bind` *means* read-only). | `SandboxMode` at `sandbox/src/index.ts:29`; the read-only restricted-SID list at `token.ts:164` |
| A read field on the policy | **Does not exist** — see the type quotes above. | `sandbox/src/index.ts:39-52, 69-72` |
| A read-side backend | **Does not exist.** All four backends are write-only profiles. | `profiles.ts:17, 35, 52` + the windows-acl header |
| `runnerCommand` override | **Not a seam for this.** It is an *operator assertion* that skips probes; it cannot add a boundary the profile language does not have, and it is a config field on the provider, not a per-call lever. | `sandbox-local/src/index.ts:44-65`, README "runnerCommand is an operator assertion" |

**The measurement that makes this a seam fact rather than a Windows fact.** The earlier pass measured Windows only, which leaves the obvious escape hatch open: "then move the deployment". So the exact argv `bwrapProfileArgs()` produces was run against a real Linux kernel (WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`):

```
$ bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- cat $BASE/outside.txt
CANARY-FAKE-SEC01-POSIX
READ_EXIT=0
$ bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- touch $BASE/outside.txt
touch: cannot touch '...': Read-only file system
WRITE_EXIT=1
```

A read of a file outside the policy root **succeeds on Linux too**, and the write is denied. The same read/write asymmetry is in the profile language itself:

- `packages/sandbox/sandbox-local/src/profiles.ts:17` — `'--ro-bind', '/', '/'` (the whole host, mounted read-only)
- `profiles.ts:35` — `landlockGrantArgs({ readOnly: ['/'], readWrite })` (read over the whole host)
- `profiles.ts:52` — `'(allow default)', '(deny file-write*)'` (Seatbelt: allow everything, deny writes)

**SEC-01 is not a Windows deployment fact. It is a seam fact, and no re-platform closes it.** This is now asserted in the suite (`sec-gates.test.ts`, "the SAME non-boundary holds on the POSIX backend"), with a SKIP-with-reason branch rather than a silent pass when no POSIX runner is present.

### What was closed

Nothing, and correctly so. The only honest options were:

- add a read-blocking denylist in this project — **rejected**: a refusal device in trusted code is not an OS/adapter boundary, which is exactly the distinction `docs/GAPS.md` E09 records;
- narrow the scenario to what the sandbox does stop — **rejected**: it would have produced a green SEC-01 about writes;
- claim enforcement that was not measured — **rejected**.

What *was* added is a second measured limitation on the same non-boundary, and it is a WRITE escape:

**A hard link inside the workspace writes through to the outside name.** Measured through the confined shell (`security-denial.test.ts`, "THE SECOND LIMITATION"):

```
linkSync(outside/target.txt, workspace/hardlink.txt)   # same inode, asserted
confined child: fs.writeFileSync(workspace/hardlink.txt, 'WRITTEN-THROUGH-HARDLINK')
  -> observed.write = 'allowed'          # correct by the policy: the PATH is inside
  -> outside/target.txt = 'WRITTEN-THROUGH-HARDLINK'   # the OUTSIDE name observes it
  -> still the same inode                # the link was NOT severed
```

This is not a bug in the containment check — the path it names *is* inside the granted root. It is the documented `partial` boundary: the README's *"Hard links are file-object aliases, not path aliases"* and the provider's own reason for reporting `partial` (`sandbox-local/src/index.ts:181-186`). The gate's write half is therefore **also** not absolute, which the earlier report did not say.

The fs seam behaves differently and both halves are recorded: `SandboxedFileSystem.writeText` does **not** refuse the hard link either, but its write is atomic (temp file + rename), so the link is severed and the outside name keeps its original bytes. **A reader who assumed the fs result covers the shell would have the shell case wrong** — which is why the shell case is measured separately.

### What remains open, and precisely why the seam cannot express it

A read boundary is unreachable through any public seam of the pinned checkout:

1. the policy type has no read field, so a caller cannot *ask* for one;
2. the mode vocabulary is file-effect only and says so in its own doc comment;
3. every backend's profile is a write profile (`--ro-bind`, `readOnly: ['/']`, `(deny file-write*)`, `WRITE_RESTRICTED`), so even a hand-written provider would have no profile language to express it;
4. the confined-run result type has no field in which a read denial could be reported, so a consumer could not distinguish a denial from a clean run.

The honest fix is not in this project. It is either (a) a read-restricted token shape (`SidsToDisable` turning SIDs deny-only, which the pinned decision note records as possible but rejected on cost — *"a read-restricted token would need per-path read grants"*), or (b) an identity route (AppContainer / separate OS user), which the same note rejects because *"every readable path must be pre-granted"*, or (c) restating the threat model to exclude reads and relying on OS user separation, which is a deployment decision the acceptance spec does not make.

---

## SEC-03 — network / egress: FAIL, and the seam cannot express it

### The enforcement seam, quoted

There is none. The evidence is the *absence* of a vocabulary, which is itself stated:

- `sandbox/src/index.ts:27` (in the `SandboxMode` doc) — *"Network and process visibility are outside this vocabulary."*
- `sandbox/src/index.ts:95-116` — `ConfinedArgv` carries no network fact.
- `packages/sandbox/sandbox-local/src/index.ts:205-213` — `DENIAL_SIGNATURES` is a FILE dialect (`'read-only file system'`, `'permission denied'`, `'operation not permitted'`, `'access is denied'`). None is a network denial.
- The runner argv is `[runner, '--workspace', …, '--temp', …, '--mode', …]` — no network argument exists to pass.

The pinned checkout's own deferred-work note is explicit that this was a deliberate exclusion, and states the exact mechanism that would be needed:

`packages/fs/../.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md:56`:

> *"**Network policy for `ctx.web`** — `SandboxMode` claims file effects only; **a web-only network knob while bash `curl` runs free would be a false boundary.** Revisit when a bash backend enforces network (**bwrap `--unshare-net`**, Landlock ABI v4+)."*

So the seam's authors knew the requirement, named the mechanism, and deferred it. `--unshare-net` appears **nowhere** in `packages/` or `docs/`.

### What was closed

Nothing. But two things were *measured* that the earlier pass only asserted:

**(a) The SSRF guard's bypass is now an observation, not a citation.** The earlier suite asserted "bypassable by any shell" by reading that sentence out of `M9.3-security-denial/FINDINGS.md`. A quoted claim is not a measurement. It is now measured in the same test: the address policy's own `isNonPublicIpLiteral('169.254.169.254')` returns `true` (the guard refuses the class), and a confined child under **`read-only`** — the strictest mode — completes a real HTTP round trip to loopback with no tool involved.

**(b) Cross-platform, on a real Linux kernel.** The exact bwrap read-only profile was run against a live listener:

```
$ bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- bash -c 'exec 3<>/dev/tcp/127.0.0.1/$PORT; head -c 64 <&3'
SEC03-POSIX-ANSWER
ROUND_TRIP_EXIT=0
$ bwrap ... -- getent hosts example.com
DNS_EXIT=0
```

The round trip completes and public DNS resolves **inside** the profile. The profile unshares the PID namespace and not the network namespace, which is the SEC-03 half of the same profile fact.

### What remains open, and precisely why the seam cannot express it

Egress control requires a network fact the seam does not carry, and a mechanism none of the four backends uses:

1. no field on `SandboxPolicy`, so a caller cannot request egress restriction;
2. no field on `ConfinedArgv`, so a consumer cannot observe one;
3. no `--unshare-net` in the bwrap profile, no Landlock network ABI use, no Seatbelt network rule, and no Windows network capability in the restricted-token shape;
4. `web-fetch-http`'s SSRF guard is a **destination filter on one tool**, not a boundary — measured above, and recorded in the pinned note as exactly the "false boundary" its authors refused to ship.

Closing SEC-03 means either a network namespace per confined execution (Linux-only) or an OS/gateway boundary outside DSH. The gate's oracle — *"未授权直连均受OS/网关阻断"* — is contradicted by measurement on both platforms.

---

## SEC-06 — capability epoch: FAIL, G-SEAM-21 CONFIRMED, plus a second instance

### G-SEAM-21 confirmed by independent scan

The scan was re-run from scratch over `packages/dsh-daily-work/src` (31 production modules, test files excluded):

- **No production module imports `./recovery.ts`.** The only importer in the whole package is `durability-records.test.ts:57`.
- **No production module reads or writes `.epoch`.** With comments stripped, the field appears in production code in exactly two places: `record.ts:439` (the zod schema declaration) and `record.ts:493` (`epoch: 1` in `initialRunRecord`). Both are *declarations*, not uses.
- **No export of `recovery.ts` reaches a runtime.** `package.json` mentions neither `recovery` nor `kernel-lifecycle`; its 11 export entries are `./data-host`, `./data-service`, `./history`, `./host`, `./package.json`, `./programmatic-scope`, `./service`, `./tool-protocol-guards`, `./tools`, `./web-search`, `./writers`.

The guard itself is real and correct — `recovery.ts:274`:

```ts
if (settlement.epoch !== record.epoch) {
  return refuse(
    `settlement carries epoch ${settlement.epoch} but run "${settlement.runId}" is at epoch ${record.epoch}; `
    + 'a stale generation cannot write authoritative state',
  )
}
```

and the refusal is total (no task transition, no reservation release) with the evidence retained in a *separate* diagnostic domain so it cannot become authority. **The mechanism is right. Nothing calls it.**

### What a cross-process stale-generation settlement would do in the absence of enforcement

The field is set to 1 by `initialRunRecord` (`record.ts:493`) and never changed. So a settlement from *any* generation of *any* host carries `epoch: 1` and matches. Concretely, with two hosts over one store (which the store's own design permits — `host.ts:413` records that a second host is refused by the home lock, so this is the *resume-after-crash* path, not the concurrent path):

1. Host A admits a child for task `t1`, reserving budget, and crashes.
2. Host B reopens the store, sees `t1` in `launching`/`executing`, and — via `reconcile.ts` — decides what to do.
3. A late callback from Host A's child arrives (a settlement carrying `runId`, `taskId`, `childId`, `to`). Because `epoch` is 1 on both sides, **the guard does not fire**.
4. The only checks left are the task lookup and `task.childId !== settlement.childId`. Those catch a *wrong child*, not a *stale generation*: a callback from the crashed generation that names the correct `childId` is accepted and calls `service.transition(...)`, which mutates authoritative state (task state, budget reservation release, terminal tombstones) and can move a task to `confirmed` for work a different generation performed.

The practical consequence is **budget accounting and terminal state corrupted by a generation that no longer exists**: a reservation released twice, or a task tombstoned by a result the current host never observed. The `unknown` resting state that `host.ts` deliberately uses to force reconciliation is exactly what a stale settlement can short-circuit.

### A second instance of the same defect class, not previously recorded

`host.ts`'s module header states the top-up contract in the grammar of enforcement (`host.ts:19-20`):

> *"After every await we re-check the run epoch, the user-cancel state and whether the owner is still the exact live Agent. A stale generation must not publish authoritative state."*

and `createRun`'s doc repeats it (`host.ts:490-492`):

> *"The root Agent is stored as an identity, **not as a string**: authority is bound to the live object plus the run epoch, so a stale callback carrying the same session id cannot write authoritative state (INV-L3)."*

**Neither is true of the code.** With comments stripped, the token `epoch` does not appear anywhere in `host.ts` — only in those two comments. The await-boundary re-check in `runDrain` is:

```ts
if (this.disposed) break        // host.ts:1265
if (signal.aborted) break       // host.ts:1266
```

and the root is persisted as **exactly the string that sentence says it is not** (`host.ts:541`):

```ts
rootSessionId: input.root.session.header.id,
```

which is precisely the identity form `tool-protocol-guards.ts` documents as insufficient: *"an id survives a replacement, an object does not."* The object-identity guard does exist and is real — but it lives in `tool-protocol-guards.ts` and covers **tool-protocol callbacks**, not the drain path that `createRun`'s sentence is about.

This is the same defect as G-SEAM-21 one layer up: the record field is inert **and** the service that owns the record claims a generation check it does not perform. It is asserted in `sec-gates.test.ts` ("host.ts claims a per-await epoch and owner re-check that its code does not perform") so it cannot be softened by a later edit.

### What was closed

Nothing was wired, deliberately. The recorded conclusion holds and was re-verified: wiring `applyWorkerSettlement` would mean **inventing a caller** rather than connecting a real one — no production path receives a worker settlement today. `recovery.ts` is also outside this agent's file ownership.

### The minimal honest fix (not applied)

Two changes, in order, and the second is the one that matters:

1. **Correct the `host.ts` header.** Delete the epoch and owner-recheck clauses from the module header and from `createRun`'s doc, replacing them with what the code does (`disposed` + `aborted`, plus the object-identity guard in `tool-protocol-guards.ts`). This is a comment fix and is the same correction `record.ts` already received.
2. **Give the settlement path a real entry point before giving it a guard.** `applyWorkerSettlement` needs a caller — the path that receives a worker's settlement. Until such a path exists, the epoch cannot be bumped or checked, and adding a bump site with no reader would be a third instance of the same defect. When that path is built, it must pass the epoch from the record it read, and the bump site must be wherever a host *re-adopts* a run (the crash-resume path in `reconcile.ts`), not a timer or a config reload.

---

## SEC-08 — NOT_RUN → BLOCKED_EXTERNAL

### The classification, with the reason

The distinction the promotion verdict needs is whether the fixture is **unbuilt** (NOT_RUN) or whether the required environment is **unavailable** (BLOCKED_EXTERNAL). It is the latter, and here is the measurement:

**The kernel half of the oracle HOLDS, and it is live.** `packages/dsh-ipython/src/kernel-plugin.ts:130-146` — `KernelService.entryFor` re-checks the kernel identity on **every** resolve, not only at creation:

```ts
// The identity is re-checked on every resolve, not only at creation: a
// configuration change that moved the execution world or the environment
// must invalidate the kernel instead of letting it serve a namespace built
// under different authority.
if (existing.identity.executionWorld !== identity.executionWorld
  || existing.identity.environmentDigest !== identity.environmentDigest) {
  throw new KernelTransportError(
    `kernel for session ${identity.sessionId} was built for execution world ` +
    `${existing.identity.executionWorld}/${existing.identity.environmentDigest} but the current ` +
    `configuration is ${identity.executionWorld}/${identity.environmentDigest}; the kernel must be evicted`,
  )
}
```

and the package's own test measures it against a **real kernel** (`service.test.ts`, "a changed execution world is refused rather than served by the old kernel") — re-run here, 1 passed. It asserts both halves: the refusal *and* that the kernel was **not** quietly replaced (`expect(s.hasKernel(agent)).toBe(true)`). A silent evict-and-restart would satisfy "a new epoch" while destroying the evidence that a domain changed under a live namespace; the refusal is the stricter and correct behaviour.

**The migration half exists and is correct, but has no runtime.** `packages/dsh-daily-work/src/kernel-lifecycle.ts:2122` implements exactly what the oracle asks:

- `kernel-lifecycle.ts:2113` — *"**THE KERNEL IS ALWAYS RESTARTED.** This is not a policy choice: the namespace holds values that were read under the OLD domain, and there is no mechanism that can enumerate them, decide which are secret, and un-read them."*
- order: *"close admission -> cancel and clean up -> new epoch"*;
- `kernel-lifecycle.ts:2158` — `kernelEpoch: previousEpoch + 1`;
- the loss is **reported, not hidden**: *"every variable read under the old domain is discarded rather than migrated, because the old values cannot be classified."*

Re-measured reachability: `kernel-lifecycle.ts` has **no production importer** (only `kernel-recovery.test.ts`, `zz-m5-trace.test.ts`, and a comment in `dep-gates.test.ts`), and `package.json` does not export it. The live `dsh-ipython` plane has no `changeReadPermissionDomain` or `readPermissionDomain` concept at all, so there is nothing for the mechanism to be wired to.

**The cross-world half cannot be exercised here.** The architecture's production answer is provisioning, not code — *"同一项目family可以读共享source；其他项目或不同读权限域使用独立execution world/VM"* and *"worker VM不是任意多个隐私域的全局共享保险箱"*. The package patch configures exactly one world (`executionWorld: local` in `packages/dsh-ipython/cordis.patch.yml`), and no container/VM/SSH execution world is mounted in this composition. **A migration needs two worlds.** Per the acceptance spec a simulated second world would not substitute, and `live_provider_budget_authorized` is `false`.

**Verdict: `BLOCKED_EXTERNAL`.** The reason is *"no second execution world exists to migrate to, and the migration mechanism has no mounted runtime; closing it needs either a provisioned second world or the kernel-lifecycle plane mounted into a production composition — both outside this package."*

This is a *stronger* statement against promotion than NOT_RUN: NOT_RUN says "we have not looked"; BLOCKED_EXTERNAL names an external dependency that must be resolved before the gate can even be attempted.

### An adjacent claim that was pinned

`kernel-lifecycle.ts:38` says the enforced boundary is that *"a kernel is a separate process with its own OS identity"*. True in the weak sense (its own pid), and false in the strong sense a reader could take from it. Measured: `packages/dsh-ipython/src/kernel.ts:191` spawns through `this.options.subprocess.spawn({...})` with **no** `ctx.sandbox.confine()` anywhere in the ipython plane. The kernel process is the **same OS user with the same ambient file and network access as the host.** What the spawn does control is a narrow environment allowlist (`DSH_IPYTHON_SPILL_DIR`, `DSH_IPYTHON_KERNEL_DIR`, `PYTHONUNBUFFERED`, `PYTHONIOENCODING`) and `stdin: 'ignore'`. That is a real control and is not OS identity separation. Asserted in `sec-gates.test.ts` so the sentence cannot be overread.

---

## The PASSes: verified, and two oracles were weaker than their claims

Every PASS gate's suite was re-run. Two assertions were **strengthened** (no claim was weakened, no test skipped, no N lowered).

| Gate | Assertion checked | Verdict |
|---|---|---|
| SEC-02 | "adds exactly one tool" | **WEAKER THAN ITS TITLE.** It asserted only that six forbidden *names* were absent, which would pass equally if the plugin registered `terminal_exec` or `admin_rpc`. **Fixed:** `expect(names.sort()).toEqual([...OUR_TOOLS].sort())` — any added tool now fails by name. Also removed the dead `OUR_TOOLS` constant's unused status by using it. |
| SEC-02 | `terminalController` unreachable | Holds. Confirmed by grep that it is **never invoked** anywhere in the package, only asserted `undefined`. |
| SEC-04 | address policy, whole-set refusal, pinned lookup, cross-origin redirect, no ambient credential | Holds. Each clause of the oracle (每跳校验目标 / 禁private网络 / 凭证不跨域转发) is measured against a real HTTP server; the redirect test stubs the address guard and says so, and the address guard is measured separately against the real resolver. |
| SEC-05 | "symlink escape refused at the handle boundary" | Holds, **but the oracle names three vectors and only symlink was covered.** **Fixed:** the hardlink vector is now measured on both paths (see SEC-01 above). Rename remains uncovered — recorded under "what is NOT proven". |
| SEC-07 | "no source claims a cell id isolates malicious code" | Holds — the scan finds no claim, and `kernel-lifecycle.ts` explicitly *denies* it (`"It is NOT a malicious-code isolation boundary"`, machine-readable as `cellIdSemantics: 'attribution-cancel-audit-only'`). **Added:** the "own OS identity" sentence is now pinned alongside the measurement that the spawn is unconfined. |

---

## What is NOT proven

Stated explicitly, because a findings document that lists only its results is the failure mode this family exists to catch.

1. **No read boundary exists on any platform tested** (Windows + WSL2 Linux). Only two platforms were measured; macOS Seatbelt was read from source (`(allow default)`, `(deny file-write*)`) and **not** executed. The source is unambiguous — allow-by-default with a write denial — but this is a source claim for macOS, not a measurement.
2. **The rename vector of SEC-05's oracle is not covered.** The oracle says `symlink/hardlink/rename逃离授权root`; symlink and hardlink are measured, rename is not. A `rename` that moves a granted-root file out, or an ancestor-directory swap, is unmeasured.
3. **The hardlink escape was measured through the confined shell and the fs seam only.** Other write paths (pwsh, PTC, a tool that opens a handle before the fence runs) were not measured.
4. **No second execution world was ever provisioned**, so SEC-08's cross-world clause is untested, not disproven.
5. **The epoch's absence of enforcement was proven by static scan, not by a live cross-process reproduction.** No test crashes a host mid-settlement and delivers a stale settlement, because there is no production path that receives one — which is itself the finding. A reproduction would have to construct the caller, which is the thing that does not exist.
6. **`host.ts`'s user-cancel re-check clause was not separately measured.** The header claims three re-checks (epoch, cancel state, owner). Epoch and owner are shown absent; the cancel state is only *partially* present — `mayAdmit` (`counting.ts:261-267`) refuses when `record.phase !== 'open'`, which covers a *cancelled* run at the admission boundary, but there is no post-await re-read of it. Recorded as a partial, not as a measurement.
7. **`enforcement: 'partial'` was taken as the backend's own report**, and its two stated causes (Everyone-granted writes, NTFS hard links) were read from the README. The Everyone case was not separately reproduced; the hardlink case was.
8. **No real credential was ever read.** Every value used is a fabricated canary (`CANARY-FAKE-…`, `CANARY-HARMLESS-…`), and a test asserts every canary literal in `sec-gates.test.ts` carries a `FAKE`/`HARMLESS` marker.
9. **`ctx.terminalController` was never invoked** in any file this agent owns; where unreachability is claimed it is proven by the *absence* of a handle and of a tool-catalog entry.

---

## Commands and results

```
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/src/dsh-src/node_modules/.bin:$PATH"

npx vitest run src/sec-gates.test.ts              # 45 passed (1 file)
npx vitest run src/security-denial.test.ts        # 17 passed (1 file)
npx vitest run src/security.test.ts               #  6 passed (1 file)
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # exit 0
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json      # exit 0
```

POSIX cross-checks were run through `wsl.exe -e bash -c` against the exact argv `bwrapProfileArgs()` produces (WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, `bwrap` at `/usr/bin/bwrap`). The suite SKIPs them with a printed reason when no POSIX runner is present rather than passing silently.

No orphan processes were left: no process matching `P3-security`, `sec-gates`, `security-denial` or `dsh-ipython` remained, and the temp directories under `qualification/results/P3-security/` were removed by their tests' `finally` blocks.

---

## Rows to add to `docs/GAPS.md`

> Another agent owns `docs/GAPS.md`. These are the exact rows, ready to paste. **G-SEAM-12 and G-SEAM-21 are NOT to be reworded into a weaker status**; the new rows are additions.

### 1. Sharpen G-SEAM-12 (append to its existing Evidence cell)

```markdown
Additionally measured on a second platform: the same read/write asymmetry holds on Linux, so this is a SEAM fact rather than a Windows fact. Running the exact argv `bwrapProfileArgs()` produces (`--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent`) against a real kernel (WSL2, 6.18.33.2-microsoft-standard-WSL2): a read of a file outside the policy root exits 0 and prints its contents, while the write fails `Read-only file system`. All four backends are write-only profiles — bwrap `--ro-bind / /` (`profiles.ts:17`), Landlock `readOnly: ['/']` (`profiles.ts:35`), Seatbelt `(allow default)` + `(deny file-write*)` (`profiles.ts:52`), windows-acl `WRITE_RESTRICTED` (`token.ts:212`). Re-platforming does not close SEC-01. A SECOND write escape was also measured, which the earlier record did not state: a hard link inside the workspace writes THROUGH to the outside name (same inode, link not severed), because a capability-SID ACE is a path check and a hard link is not a path relation. Measured through the confined shell; the fs seam's atomic write severs the link instead, so the two paths differ and both are recorded. Evidence: `qualification/results/P3-security/FINDINGS.md`.
```

### 2. New row for the egress seam (add to the G-SEAM table)

```markdown
| G-SEAM-22 | **The sandbox seam has no network vocabulary, and the pinned checkout says so as a deliberate deferral.** | OPEN — named mechanism never implemented | `SandboxMode`'s own doc comment: "Network and process visibility are outside this vocabulary" (`packages/sandbox/sandbox/src/index.ts:27`). `ConfinedArgv` carries no network fact, and `DENIAL_SIGNATURES` is a FILE dialect (`sandbox-local/src/index.ts:205-213`). The pinned decision note names the exact mechanism and defers it: "a web-only network knob while bash `curl` runs free would be a false boundary. Revisit when a bash backend enforces network (bwrap `--unshare-net`, Landlock ABI v4+)" (`.agents/notes/implemented/feature/2026-07-14-cross-family-fs-sandbox.md:56`). `--unshare-net` appears nowhere in `packages/` or `docs/`. MEASURED on two platforms: a confined child completes an HTTP round trip to loopback and a LAN TCP connect under both confined modes on Windows, and the bwrap profile (which carries `--unshare-pid` and NOT `--unshare-net`) completes a loopback round trip and resolves public DNS inside the profile on Linux. The `web-fetch-http` SSRF guard is a destination filter on one tool and was measured being bypassed by a confined child under `read-only`. Evidence: `qualification/results/P3-security/FINDINGS.md`. |
```

### 3. Add a FOURTH row to the "unwired mechanism" defect-class table (line ~85-92)

```markdown
| 4 | `host.ts` module header + `createRun` doc — claim a per-await epoch and owner re-check | the words are in the file and the checks are not: `runDrain` re-checks only `this.disposed` and `signal.aborted` (`host.ts:1265-1266`), the token `epoch` appears nowhere in the code, and the doc's own "an identity, **not as a string**" is contradicted by the very next assignment (`host.ts:541` stores `rootSessionId: input.root.session.header.id`) — the exact identity form `tool-protocol-guards.ts` documents as insufficient | OPEN (see G-SEAM-21) |
```

### 4. Append to G-SEAM-21's Evidence cell

```markdown
G-SEAM-21 CONFIRMED by independent re-scan (31 production modules; no non-test importer of `recovery.ts`; with comments stripped, `.epoch` appears in production code only as the schema declaration `record.ts:439` and the initializer `record.ts:493` — both declarations, neither a use). **A SECOND instance of the same defect class was found in a file the entry did not name:** `host.ts`'s module header states "After every await we re-check the run epoch, the user-cancel state and whether the owner is still the exact live Agent. A stale generation must not publish authoritative state" (`host.ts:19-20`), and `createRun` repeats it more strongly — "The root Agent is stored as an identity, **not as a string**: authority is bound to the live object plus the run epoch" (`host.ts:490-492`) — but with comments stripped the token `epoch` does not appear anywhere in `host.ts`, the await-boundary re-check is only `this.disposed` and `signal.aborted`, and the root IS stored as the string the sentence disclaims (`host.ts:541`). The object-identity guard that does exist (`tool-protocol-guards.ts`) covers tool-protocol callbacks, not the drain path `createRun` describes. The minimal honest fix is in two parts: (1) correct the `host.ts` header the way `record.ts` was corrected; (2) build the settlement entry point BEFORE wiring the guard, and bump the epoch at the crash-resume re-adoption site (`reconcile.ts`), not on a timer. Evidence: `qualification/results/P3-security/FINDINGS.md`. |
```

### 5. New row for the kernel-process identity claim (add to the G-SEAM table)

```markdown
| G-SEAM-23 | `kernel-lifecycle.ts` claims the kernel process has "its own OS identity"; it does not. | OPEN — claim pinned, measurement recorded | `kernel-lifecycle.ts:38` states the enforced boundary is "a kernel is a separate process with its own OS identity". True in the weak sense (its own pid), false in the strong sense a reader could take. MEASURED: `packages/dsh-ipython/src/kernel.ts:191` spawns via `this.options.subprocess.spawn({...})` with NO `ctx.sandbox.confine()` anywhere in the ipython plane, so the kernel process runs as the SAME OS user with the same ambient file and network access as the host. The real controls are a narrow environment allowlist (`DSH_IPYTHON_SPILL_DIR`, `DSH_IPYTHON_KERNEL_DIR`, `PYTHONUNBUFFERED`, `PYTHONIOENCODING`) and `stdin: 'ignore'`. Related: `kernel-lifecycle.ts` also implements `changeReadPermissionDomain` (`:2122`) with the correct order (close admission -> cancel and clean up -> new epoch, `kernelEpoch: previousEpoch + 1`) and discards rather than migrates the namespace — but it has no production importer and the package does not export it, and the live ipython plane has no read-permission-domain concept at all. Evidence: `qualification/results/P3-security/FINDINGS.md`. |
```

### 6. Status correction in the UPG-08 verdict table

```markdown
| SEC-08 | BLOCKED_EXTERNAL | The kernel half of the oracle HOLDS and is measured on the live plane (`KernelService.entryFor` refuses a changed execution world and does not silently replace the kernel; the package's own test reproduces it against a real kernel). The migration half EXISTS and is correct (`changeReadPermissionDomain`, `kernel-lifecycle.ts:2122`) but has no production importer and is not exported. The cross-world half cannot be exercised: the architecture requires an independent execution world per read-permission domain, this deployment configures exactly one (`executionWorld: local`), and no container/VM/SSH world is mounted — a migration needs TWO worlds, and per the spec a simulated one does not substitute. NOT_RUN understated it: the fixture is not unbuilt, the required environment is unavailable. |
```
