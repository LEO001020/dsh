# M-DEP-SEC-UPG — the DEP, SEC and UPG acceptance families (24 gates)

**Date:** 2026-09-20
**Host:** Windows 11 (10.0.26200) AMD64, Node v24.18.0
**Pinned DSH:** `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`)
**Spec:** `qualification/specs/acceptance-spec.json` (`schema_version: 2`, 112 mandatory cases,
sha256 `2fe95835425eb98eb3bac9eead17985df5bf951669460c8d7a87b8887afb1e0b` — byte-identical to the
audit package's `delivery/acceptance-spec.json`)
**Evidence:** `tests.txt` (118 passed, exit 0), `tsc.txt`, `source-digests.txt`,
`typecheck-errors.txt`, `declared-vs-imported.txt`, `UPG-08-verdict.txt`,
and the three gate files `src/dep-gates.test.ts` / `src/sec-gates.test.ts` / `src/upg-gates.test.ts`.

## Verdict summary

| status | count | gates |
|---|---|---|
| PASS | 16 | DEP-01, DEP-02, DEP-03, DEP-05, DEP-06, DEP-07, DEP-08, SEC-02, SEC-04, SEC-05, SEC-07, UPG-01, UPG-02, UPG-03, UPG-04, UPG-05 |
| **FAIL** | **4** | SEC-01, SEC-03, SEC-06, UPG-06 |
| NOT_RUN | 3 | DEP-04, SEC-08, UPG-08 (this report) |
| BLOCKED_EXTERNAL | 1 | UPG-07 |

**Daily verdict: NOT_READY.** Derived, not typed: `UPG-08-verdict.txt` is written by the test
itself from the per-gate table, so the verdict cannot disagree with the rows.

The headline honest statement: **four of the 24 gates are honest FAILs, and two of those four are
the same platform finding the project already records.** Nothing here was softened to make a gate
greener; where the platform does not deny, the test asserts the observed non-denial and this file
records the gate as unmet.

One gate moved during this work, and the movement is recorded rather than absorbed: **DEP-03 was a
FAIL and is now PASS.** Its first measurement found the tree uncompilable (30+ type errors across 18
files that belong to concurrent work in the same checkout); that work has since settled and three
consecutive runs of the same command now exit 0 with zero errors. The test asserts the ORACLE
(clean, exit 0) rather than pinning a count, and `typecheck-errors.txt` records both the current
zero and the earlier failure history.

---

## DEP · integration

### DEP-01 identity lock — PASS

Oracle: 真实首tool成功；记录module graph；不只检查--help.

Three existing evidence files are **cited rather than re-run**, because a re-run would still be the
same two launchers and would cost a full boot:

- `M0.4-first-toolcall/A03-first-toolcall.txt` — a real tool round trip through the real host and the
  production `AgentLoop`, with the tool/result carrying `CLI_TOOL_ROUND_TRIP`, exit 0. That file
  states in its own text that it does **not** prove `apps/cli/lib/bin.js`; the test pins that scope
  limit so a later reader cannot overread it.
- `M8.5-c2-real-boot/e2e-tool.json` — a real Session on the composed `daily-standard` preset
  reporting **27** tools including `work`. This is what makes "the first native call is possible"
  non-vacuous. Both scope-key counts are retained (`toolCountAgentKey: 27`, `toolCountContextKey: 0`)
  so the agent-object key is evidence rather than folklore.
- `M0.6-launcher-identity/A03-launcher-identity.txt` — the built and source launchers are different
  distribution identities, **reproduced 3/3**.

Added: the deployment identity digest, the three C0 dump digests, and a resolution check that each
extension peer resolves to a built path inside the pinned checkout rather than a `.ts`.

### DEP-02 old-evidence isolation — PASS

The new spec is installed at `qualification/specs/acceptance-spec.json` and asserted to be
**byte-identical** to the audit package's copy (digest pinned). All 112 cases are `NOT_RUN` with
**zero** pre-attached evidence; the four tiers and the fourteen ID families are each pinned so a
truncated or padded spec cannot pass.

The failure mode is specific and is asserted: the OLD `qualification/gates.json` holds **104 rows
with 85 PASS**, and its ID space (`A01`…) is **disjoint** from the new one (`DEP-01`…). An id-keyed
migration would therefore find no collision and could count 104 old PASSes as evidence for 112 new
cases. The test asserts the disjointness, and asserts that `build-gates.py` reads only
`gate-spec.json` — never `acceptance-spec.json` — so the old report cannot become a producer for
the new spec.

### DEP-03 public exports — PASS

Oracle: 编译全部生产包与tests；不得deep-import私有Symbol或通过any绕过.

**This is the false pass the gate exists to catch, and it was caught.** The two configs were
measured against each other:

| config | excludes | result |
|---|---|---|
| `tsconfig.json` | `src/**/*.test.ts` | **exit 0** — with or without any test file present |
| `tsconfig.check.json` | nothing | **exit 0**, zero errors, tests included |

**The gate's first measurement was a FAIL, and that is recorded rather than erased.** An earlier run
of the same command found **30+ type errors across 18 files**: `kernel-lifecycle.ts`,
`target-setting.ts`, `capacity.ts`, `artifacts.ts`, `observations.ts`, several test files, and one
pinned-checkout file (`tool-fs-search/src/direct-call.ts` could not resolve
`@deepseek-ai/dsh-util-values`). Those files were under concurrent construction in this same
checkout; none was in a file this work owns. That work has since settled, and **three consecutive
runs** of `tsc -p tsconfig.check.json` now exit 0 with zero errors.

The test therefore asserts the **oracle** — clean, exit 0, with tests included — rather than pinning
a count, because the gate's claim is "all production packages AND tests compile" and a non-zero
count falsifies it whenever it appears. `typecheck-errors.txt` is rewritten on every run and records
both the current zero and the earlier failure history, so the movement is visible to a later reader.

Also measured and asserted: **no** `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` and **no** `any`
type annotation in any production source (comments stripped first — one file carries a comment
explaining why an `as any`-shaped narrowing is *not* the forbidden bypass, and a naive line scan
flagged it). Every declared export points at a built file that exists. **Zero** deep private
imports: each peer subpath is validated against that peer's OWN `exports` map.

One sibling defect is **recorded rather than asserted away**: production sources import **12 DSH
peers that `package.json` does not declare** — `dsh-attachment-local`, `dsh-fs`, `dsh-llm`,
`dsh-session`, `dsh-session-query`, `dsh-settings`, `dsh-storage`, `dsh-storage-json`,
`dsh-subprocess`, `dsh-subprocess-local`, `dsh-util-values`, `schemastery`. They resolve here
through the junction farm and can fail in a real install. `declared-vs-imported.txt` carries the
full measured list (19 imported, 12 undeclared). The test asserts the hard invariant — every
imported peer RESOLVES — and records the manifest gap rather than pinning it to a list, because the
list churns with the tree and a pinned list would say nothing.

### DEP-04 SSH path consistency — NOT_RUN

Oracle: 同一路径分别native read/grep/process/Web查看；解析同executionWorld；不误读host同名文件.

**Determined from the source, and the honest answer on this machine is that no SSH execution world
exists here.** The audit's production path is "trusted DSH host + first-party SSH execution world +
dedicated Linux VM" (ARCHITECTURE §13); this deployment mounts the LOCAL providers. Two facts are
established:

1. **The one-world contract is a real property of the pinned checkout.** `SshFileSystem`,
   `SshSubprocessRuntime` and `SshSandboxProvider` all `inject: ['ssh']` and route every operation
   through the SAME connection. `processPath()` returns the REMOTE identity, containment is decided
   with `posix.relative` on the remote spelling, and the `file:` URI is derived from the remote path
   — never from a host path. The checkout's own architecture note states "`ctx.fs` and
   `ctx.subprocess` together define one execution world".
2. **On this deployment the mounted providers are LOCAL**, so the only world that exists is the
   host's. The test asserts that, including that `ctx.get('ssh')` is `undefined`.

The gate's specific hazard — "do not misread a same-named file on the host" — **cannot be expressed
without a second world to be confused with**, which is why the SSH half is NOT_RUN rather than PASS.
**No remote world is claimed.**

### DEP-05 missing provider — PASS

Oracle: 移除subprocess/sandbox/SSH依赖；loader失败明确；不降为danger-full-access.

Three independent refusals, each asserted at its own layer:

1. `SandboxBashExecutor.inject` names `sandbox`, `subprocess` and `sandboxPolicy`, so a composition
   without them cannot activate the executor at all — Cordis parks it rather than running it
   unconfined.
2. `terminal-bash` refuses **at spawn time** with an explicit message
   (`requires a ctx.sandbox provider in the execution world`). The test asserts the **order**:
   `if (policy.mode === 'danger-full-access') return argv` comes BEFORE the refusal, so an
   unconfined mode needs no provider and a confined one cannot proceed without it. That ordering is
   the guarantee, not the message.
3. The sandbox-policy schema default is `read-only` — the **strictest** mode — so an unconfigured
   host narrows rather than widens. Asserted that no `danger-full-access` default exists, and that
   `workspaceRoot` has no schema default (so its fallback is real branching, never an empty string
   that would match everything).

And the fail-closed control: with nothing mounted there is no `shell` at all, so a model cannot run
a command through a service that does not exist. The unconfined executor is a **separate package**,
so acquiring it is a visible composition change rather than a fallback — and it reports
`sandboxMode: undefined`, not `danger-full-access`.

### DEP-06 home-lock race — PASS

Oracle: A/B同时看见dead holder后交错rename/link；只能一个WorkService获得真实独占；另一拒绝.

The 7 in-process tests in `src/homelock.test.ts` are **cited by behaviour name** rather than
duplicated. The reproduced A/B interleaving is cited from
`M10.0-audit-repro/stale-lock-local.json`: both contenders returned success, the second renamed the
first's LIVE lock aside, and the stable-handle control rejected a second acquisition. The audit's
own probe imports `fcntl` and cannot run on Windows at all; the replacement is asserted not to.

**Added: the REAL two-process variant.** A first child process boots a real `WorkService` over the
real storage stack and holds the kernel lock; a second, different process over the SAME store and
lock is **refused** with `HomeLockHeldError` naming the holder's pid and stating that the lock is
kernel-held with no stale file to delete. The holder then closes cleanly and the same path is
acquirable — so the refusal was exclusion, not a broken lock.

### DEP-07 lock release stability — PASS

Oracle: holder crash/restart并发acquire；同inode OS锁释放；不按PID/TTL盗取活锁.

**The anti-theft half is the load-bearing one.** A real child process takes the lock and waits on a
live timer. While it is ALIVE the lock is refused **twice** — a TTL-based protocol would free the
lock here if the holder were merely slow, and this assertion would then fail. The holder is then
SIGKILLed (uncatchable, so no cleanup handler runs) and the successor acquires **with no manual
intervention**: no lock-file deletion, no TTL wait, no PID probe. The dead holder's advisory note
is still on disk and does not matter; the live successor's note replaces it.

The source is asserted to match: the mechanism is `CreateSemaphoreW`/`WaitForSingleObject` on
Windows and `flock` + inode verification on POSIX; `holderProvenGone` appears **only** in the
comment recording its removal (count pinned at 1); `TTL` appears **only** in the two comments
rejecting it; and there is no `unlink()` — keeping the inode stable is what later lockers verify
against. The documented SCOPE limit is pinned too: this excludes a second host on the **same
machine**, and a store shared across machines is not covered.

### DEP-08 full build coverage — PASS

Oracle: 故意在test文件注入类型错误；typecheck确实失败；tests不得被排除.

**This gate genuinely goes red.** The fixture is a minimal `src/` holding one production file and
one test file, checked with the REAL, VERBATIM `tsconfig.json` and `tsconfig.check.json` copied from
this package — a synthetic config would prove nothing about the ones actually used.

| step | observation |
|---|---|
| baseline, both configs | **exit 0** |
| inject `export const __dep08Injected: number = 'this is not a number'` into the TEST file | — |
| **build** config on the mutated tree | **exit 0** — it excludes `src/**/*.test.ts`, so it cannot see the error. This is the false pass, demonstrated. |
| **check** config on the mutated tree | **exit ≠ 0**, `error TS2322`, located in `subject.test.ts` |
| remove the injection | **exit 0** restored |

The fixture lives inside the package so module resolution reaches the package's own `node_modules`,
and it is removed in a `finally`; a separate test asserts no fixture is left behind and that the
real configs still carry their exclude.

The controlled fixture is deliberate: the real tree is under concurrent construction, so a
whole-tree baseline is not clean and a whole-tree failure could not be attributed to the injection.
DEP-03 measures the real tree separately and records its actual result.

---

## SEC · security

### SEC-01 host secret — **FAIL**

Oracle: native read和Python直接读host HOME/DSH_HOME/proc；两条路径都不可达；ro host root不是保密.

**Re-measured, and the platform does not deny.** A confined child **READS** a file outside the
workspace root under **both** `read-only` and `workspace-write`, exit 0, verbatim, with no denial
signature on stderr. A fabricated `fake-home/.dsh/credentials.json` is likewise readable. This is
`docs/GAPS.md` G-SEAM-12 and `M9.3-security-denial/FINDINGS.md` E01, restated as an executable fact.

The limit is **structural**, and that is asserted three ways so it cannot be papered over later:

- `SandboxPolicy` adds exactly ONE thing to `SandboxExecutionPolicy` — a narrowed `mode` — and the
  base carries `mode` + `workspaceRoot` (+ `sessionId`). There is **no read field**, so the oracle
  cannot be satisfied even in principle.
- The Windows backend's own header: *"writes are restricted; reads, network, and process visibility
  are NOT (WRITE_RESTRICTED intersects only write accesses)"*.
- `ConfinedArgv`'s field names are exactly `argv`, `enforcement`, `denialSignatures`,
  `runnerFailureRules` — a caller cannot even OBSERVE a read denial.

The write boundary DOES hold (asserted as the control: an outside write is denied and the file does
not exist), which is why the honest statement is that this is a **durability** property and not a
confidentiality one. The credential-name scrub (`/KEY|PASSWORD|SECRET|TOKEN/i` plus every `DSH_*`
name) is real and is asserted — together with the recorded fact that it is a NAME heuristic in
trusted code, defeated by any credential stored in a FILE.

### SEC-02 control-plane bypass — PASS

Oracle: kernel调用human terminal/plugin manager/管理RPC；拒绝，不能因localhost视为可信.

The load-bearing claim is not a scope test — `ctx.get(name)` is a process-wide registry read, which
`control-plane.test.ts` already pins as a corrected measurement error. It is: **the model reaches
things through tools, and `tools.schemas(agent)` is the exact catalog it is offered.** Measured on a
real `dsh --profile daily` boot: 27 tools including `work`, `exposedAsTool: []`, all **23** declared
surfaces checked individually, **zero** exposed.

`ctx.terminalController` is **never called anywhere in this file**. Its own module header is quoted:
*"Session-owned user terminals with the execution environment's system-user permissions"*, and
`create()` is documented as allocating *"without Agent sandbox or approval restrictions"*. The
structural fact is asserted: `spawn()` calls `spawnTerminal()` with **no** `confine(` in the call,
and the sandbox policy is consulted only for a fallback working DIRECTORY. A future version that
wraps the PTY fails this test.

Added: the tool registry itself refuses every control-plane-shaped name as `unknown tool` on an
EMPTY catalog, so the refusal is the registry's own rather than a policy that could be
reconfigured away. And the loopback facts are cited: **401** unauthenticated, **403** for a hostile
Host on `/api` — with the correction that the index route is auth-fenced, **not** Host-fenced, so
the rebinding defence is an `/api` property rather than a server-wide one.

### SEC-03 external network — **FAIL**

Oracle: DNS/IPv4/IPv6/局域网/cloud metadata访问；未授权直连均受OS/网关阻断；记录真实结果.

**No egress control exists, and the absence is demonstrated rather than assumed.** Measured per
destination class, each asserted as itself:

| destination | observed |
|---|---|
| loopback HTTP server (both confined modes) | **`HTTP_OK:<body>`** — a completed round trip |
| a private LAN address (`192.168.1.1:445`) | **`CONNECTED`** |
| public DNS (`example.com`) | resolves (`198.18.2.76`) |
| private DNS (`localhost`) | resolves (`127.0.0.1`) |
| cloud metadata (`169.254.169.254:80`) | `ENETUNREACH` — **this host has no route to the link-local address. That is a property of the network, not a control in the sandbox.** |
| IPv6 loopback | transport answer received (refused by the listener) |

The distinction between those rows is the finding, and collapsing it would hide which destinations
are actually reachable. The seam carries **no network fact**: `ConfinedArgv` has no network field,
the runner argv carries only `--workspace`/`--temp`/`--mode`, and no denial signature is a network
one. The only egress-adjacent control is `web_fetch`'s SSRF filter, which is a destination filter on
ONE tool and is bypassed by any shell command — which the loopback row above proves.

### SEC-04 SSRF — PASS

Oracle: web工具重定向/重绑定到private地址；每跳校验目标，凭证不跨域转发.

**A real control at a real boundary, exercised against a real HTTP server.** Every clause measured:

- **Address policy**: 22 address classes refused, including the two classic bypasses — the
  unspecified address and an IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`). The control: genuinely
  public unicast (IPv4 and IPv6) is permitted, so this is a filter and not a blanket refusal.
- **DNS rebinding**: an answer set mixing a public and a private address is refused **WHOLE**
  (`WEB_BLOCKED_URL`) — accepting the public one and retrying would be a race. An empty answer set is
  an error, never an empty allow-list.
- **Pinning**: the pinned lookup is not just asserted structurally — it is CALLED and shown to answer
  from the fixed set, because a stub that consulted the system resolver would pass a structural
  check while doing nothing.
- **Redirects** (against a real server): same-origin followed; **cross-origin REFUSED**
  (`WEB_REDIRECT_BLOCKED`) and the attacker's path was never requested; a credentialed redirect
  target refused (`credentials in URLs are not allowed`); a non-http(s) scheme refused
  (`WEB_INVALID_URL`); a redirect loop bounded at the hop cap.
- **Credentials**: the request headers are a fixed literal — `user-agent` and `accept` only, no
  cookie or authorization key — and every transport uses `redirect: 'manual'`, which is what makes
  per-hop validation possible at all.

The limit is asserted as well: this is a destination filter on one tool, **not** an egress boundary.

### SEC-05 path race — PASS

Oracle: symlink/hardlink/rename逃离授权root；provider实际handle边界拒绝，非仅字符串检查.

A symlink inside the workspace pointing outside it is refused with **`FS_SANDBOX_DENIED`**, the
outside file is **byte-identical** afterwards, and the link is still a link. The control: a file
inside the workspace IS writable, so the refusal is containment rather than a dead fence.

The mechanism is asserted from the source: `checkedTarget` re-canonicalizes NOW and returns the
**fresh** target, so the identity that was checked is the identity that is mutated — the
check-here-write-there TOCTOU is closed. When spellings differ, containment compares **dev/ino**
rather than text, which is what recognizes Windows long-name/8.3 aliases without weakening
containment to a textual approximation; `isPathUnder` is exercised directly on a real tree.

**A measurement error is recorded because it would have produced a false green.** The first version
of this probe put the "outside" directory under `os.tmpdir()`, and `writableRoots()` explicitly
GRANTS the platform temp area under `workspace-write`. The write then succeeded — correctly, by
policy — and would have read as a fence failure. The fixture now uses a directory outside every
granted root, and a comment records why.

The fence's own scope limit is pinned: it is *"a policy check in TRUSTED code over a
MODEL-CONTROLLED path, NOT a kernel boundary"*, and the residual ancestor-symlink TOCTOU is
*narrowed* rather than eliminated. Reads pass through untouched in every mode, which is SEC-01's
finding stated as a deliberate design property.

### SEC-06 capability epoch — **FAIL**

Oracle: park后旧RPC、reset后旧引用/旧tool请求；旧执行权限失效；数据ref仍需当前授权.

**The mechanism exists, is tested, and is UNREACHABLE from production.** `recovery.ts` implements a
stale-epoch refusal with its own reason string naming both epochs, and `durability-records.test.ts`
D10 measures it. But `docs/GAPS.md` G-SEAM-21 records the load-bearing finding: `recovery.ts` has
**no non-test importer**, `applyWorkerSettlement` has no caller outside its module and its own test,
and nothing outside `recovery.ts` reads or writes `.epoch` after `initialRunRecord` sets it to 1. So
nothing bumps the epoch and nothing checks it: **the field is inert in the product.**

That is worse than a missing feature would be, because `record.ts` stated *"a callback carrying a
stale epoch must be rejected"* as if it were a property — a requirement written in the grammar of
enforcement. A gate that accepted the sentence would be reading a comment as a control. The GAPS
entry records that the claim was corrected, and this file **re-measures the reachability** with its
own import-graph scan over production sources rather than inheriting the conclusion: the importer
list is empty.

What IS enforced is a live Agent's identity by **object** comparison
(`ctx.agents.get(id) === owner`), which covers an in-process resume; the cross-PROCESS generation
case the field promises is **not** covered. The kernel park/reset half is NOT_RUN: the
`dsh-ipython` package exists with an empty `src/`, and the IPython mechanics that DO exist are the
audit's protocol self-checks, which its own text says are not evidence for a DSH or data-plane gate.
The interrupt-that-does-not-settle case is cited as a real, reproduced limit rather than a
hypothetical.

### SEC-07 same-kernel thread — PASS

Oracle: 旧background task在新cell活跃；不把cell id宣称恶意代码隔离；越Session/host权限仍拒绝.

**The gate asks for the honest statement, and the honest statement is that a cell id does NOT
isolate malicious code.** A thread or C extension started in cell N keeps running in cell N+1 and
can read and mutate the namespace. So this file asserts the **absence of the claim**: no source in
this package contains any of four isolation phrasings (patterns chosen to match a claim and not a
denial of one), and the check is asserted to be non-vacuous.

What DOES hold is asserted instead, in terms of ownership rather than isolation: the cross-Session
and host-privilege refusals (`terminalController`, `pluginManager`, `authorization`, `remote`,
`webTerminals`, `webhookRuntime` all unreachable), and the tool-protocol guard's object-identity
comparison. The architecture's own limit is cited: a monkeypatch inside IPython affects untrusted
payload only and *"不能改变host的artifact ACL、tool执行记录或验收判决"*.

The transport limit is cited from both records: the default `jupyter_client` path yields a
**plaintext TCP** kernel channel, CurveZMQ removes it only when asked for, and `transport='ipc'` —
the audit's FIRST preference — **fails on Windows** because libzmq is built without IPC support. A
readable connection file is an execution capability, since it carries the HMAC key.

### SEC-08 role change — NOT_RUN

Oracle: read权限域/项目变更后重用kernel；必须新epoch/受控迁移；不带旧域秘密变量.

**There is no runtime role migration in this deployment, and the architecture's answer is
structural rather than a runtime feature**: *"同一项目family可以读共享source；其他项目或不同读权限域
使用独立execution world/VM"*, and *"worker VM不是任意多个隐私域的全局共享保险箱"*. The mechanism this
package actually has is isolation **by separate store plus the home lock**, which the test asserts
(a second domain is a different store with its own exclusive holder; the domain name is a single
constant; a schema change requires an offline conversion or a new namespace with an explicit
cutover).

The "no old-domain secret variable" clause is measured and holds for a real reason: the patch NAMES
a credential reference (`apiKeyEnv: EXA_API_KEY`) and contains no credential value at all, and the
subprocess seam drops credential-shaped and `DSH_*` names. But the execution-world separation the
gate's oracle requires is **not built**, so this gate is NOT_RUN rather than PASS — a store
boundary is not an execution-world boundary.

---

## UPG · integration

### UPG-01 compiled install — PASS

Oracle: 从实际发布/构建包安装候选profile；没有依赖源码绝对路径；第一次python/native调用成功.

The built-output half is asserted from the artifacts: `lib/` exists, every declared export points at
a `./lib/*.js` + `./lib/*.d.ts` pair that EXISTS, and **every production source has a compiled
counterpart** — so `lib/` is not a stale subset that happens to satisfy the exports. The built
modules are then IMPORTED at runtime, so "it is built" is a runtime fact rather than a directory
listing.

The install half is measured against the installed profile: it depends on the package by `link:`,
declares the bundle in `dsh.profile.bundles` (which is what activates its layer), the link resolves,
and the linked package's `main` is built. The `dsh.bundle.patch` declaration is asserted, because
without it the resolver installs the code and activates **no layer** — the G-FIX-04 defect.

No absolute source path: every plugin `name:` in both the candidate patch and the package's bundle
patch is asserted to be a package specifier, and neither file contains a drive-letter path or a
`file://` URL.

The reach limit is recorded rather than implied: the dependency is a `link:` to this checkout, so
this is a **development install**, not a published one. The measured resolver result is cited
(`M9.17`): exactly ONE built copy of each peer across three resolution roots, `sourceResolved: []`,
and the lesson pinned — *"a gate whose oracle is weaker than its scenario will pass while the
product is broken."*

### UPG-02 Session schema upgrade — PASS

Oracle: 旧Session含新增compute/observation记录；按版本迁移/明确拒绝，不能丢未知事件装正常.

The mechanism is measured, not described, and the second half is the subtle one:

| stimulus | observation |
|---|---|
| stored version NEWER than this build writes | `readHeader` → **`unsupported`**, naming `storedVersion` and `targetVersion` and the direction |
| unknown event type, no `ignorable` marker | the row **DECODES**, then `finish()` **FAILS** with `SessionFormatUnsupportedMigrationError` naming the type and seq |
| the SAME event with `ignorable: true` | **retained** — the event count includes it and the marker survives |

The decode-then-fail shape is the trap and is called out: a consumer that stopped after `decodeRow`
would read the log as intact. The marker is the ONLY admission path, and the seam's own text says
why a name registry was rejected — *"it does not classify omission safety and would make reads
composition-dependent"*. The v2→v3 migration is asserted to refuse an unclassified event rather than
pass it through, and its PTC admission rule lives in the validation module (a separate file from the
payload module, which is where a first reading of this test went looking).

### UPG-03 artifact compatibility — PASS

Oracle: 旧spill locator与新refs并存；权限/生命周期明确，旧数据不被删除或错误重新归属.

An OLD locator and a NEW locator coexist and **both** remain readable; the old file's digest is
unchanged after further writes by the new session. The locator is **session-scoped** (a sha256 of
the session id, so it is stable across restarts — a random name would orphan every existing locator)
and hostile ids with `..` cannot escape the root.

The sweep is measured on a real tree: an expired file is reclaimed, a recent file survives, and a
`session-backup` directory is **never** touched — because the selection is exact-shape
(`^session-[0-9a-f]{12}$`) rather than prefix-based. That is the "wrongly re-owned" hazard closed by
a shape rule. Permissions are declared in the source (`mode: 0o700` for the directory, `'wx'` +
`0o600` for the file) rather than left to the umask.

### UPG-04 backup/restore — PASS

Oracle: 备份Session+artifact+config后在新host恢复；hash/identity可验证，kernel volatile明确不在备份.

A store is seeded, hashed, **copied to a different directory**, and reopened by a fresh host over
the copy: the trees are **byte-identical**, the run reopens with the same `runId`,
`rootSessionId`, `authorizationRef`, `epoch` (1 — a restore is not a new generation) and
`requestedTarget`, and the counts recompute from stored state. The SOURCE is unchanged by the
restore, so a backup is not destructive.

**Kernel volatile state is excluded structurally**: the check is on the store's FIELD NAMES (a value
could legitimately contain the word "kernel"), and no `kernel`/`namespace`/`connectionfile`/
`curve_secretkey`/`ipykernel`/`variables` field exists. The audit's own text is cited for the
volatile-kernel rule and for the recovery manifest's obligation to report
as-of/loaded/skipped/lost rather than claim complete recovery.

The artifact half uses the real content-addressed primitive: the host-computed digest **equals** the
content's digest, the object's PATH contains that digest, and the bytes on disk re-hash to it. The
config half is safe to restore because the credential is a NAME, never a value.

### UPG-05 rollback — PASS

Oracle: 回滚runtime代码不回滚外部世界；新schema数据可读或安全拒绝，保留effects未知.

**The "safely refused" half is measured on this project's own store**: a newer unit version makes
the open fail with `StorageError`/`version-mismatch`, and the file's bytes are **byte-identical
afterwards** — a rollback that corrupted the newer data while refusing it would be worse than one
that read it wrongly. The control: restoring the original bytes makes the store open normally, so
the refusal is about the version rather than a directory left unusable.

**The external-world half is cited from the existing rehearsal**
(`M9.20-real-tasks/u06-rollback.mjs`), whose three clauses are exactly this gate's: the old artifact
plus an old consistency snapshot restored byte-for-byte; the external effect **reconciled** using
the REAL effect ledger and the remote reached **zero** times through `perform`; and the assertion
that makes the gate worth running — *"after the rollback, the remote's counter still reads 1. The
software went back; the send did not."* The rehearsal also names its own fixtures: the "new version"
is a version-bumped copy of the SAME code because no newer release exists, and the remote is a
counting fake because no real remote is authorized.

The architecture's rules are cited: disk state, kernel memory and remote state do **not** roll back
automatically, and a general cell does not acquire exactly-once because a specific adapter can be
reconciled.

### UPG-06 GC live references — **FAIL**

Oracle: 原Session/fork/activelease仍引用artifact；不能被startup cleanup或按目录age误删.

**The gate's property does NOT hold for spill artifacts, and the test proves it by deleting one.**
A spill artifact written by a session that is still live and still references it, aged past the
cutoff, is **GONE** after `sweepSpillRoots`. The reason is structural and asserted: `SweepOptions`
carries `cutoffMs` and `warn` and **no reference, lease or live-session input**, so the sweep cannot
respect a live reference — this is not a misconfiguration. The spill seam's own docs confirm the
absence of a reference contract (`saveText` only: no `open`, no `stat`, no range read, no delete),
and this project's `artifacts.ts` records the same gap.

The content-addressed artifact store **does** survive — an object aged a year is untouched by the
spill sweep. But that is recorded as the **weaker** of the two ways to hold the property: it holds
because the store has **no collector at all**, not because a collector respects references. "No GC"
and "a correct GC" are different facts, and only the first is true here.

What does exist is the reference's durable half: the run record is the holder, it survives a
restart, and it carries a `lastReconciledRefs` field — the shape a future reference-aware collector
would consult. That is a prerequisite, not the gate.

### UPG-07 real 30-provider — **BLOCKED_EXTERNAL**

**Exact reason, from `compatibility.lock.json`:**

```
runtime_authorization.live_provider_budget_authorized: false
```

`docs/GAPS.md` G-EXT-01/G-EXT-02 record the same, and state the rule the lock implies: *"A model API
key being present does not authorize large paid evaluation."* The gate's own text forbids a
substitute — the spec's UPG-07 oracle reads **mock结果不替代本门**, and the acceptance document adds
that a blocked UPG-07 still yields NOT_READY.

**Nothing in this work manufactures a result for this gate.** No provider-driving API is called
anywhere in `upg-gates.test.ts` — asserted by scanning this file's own code with comments and string
literals stripped, so the file's list of forbidden names is not mistaken for a call. The mock-based
N=10 result exists as its own evidence and is asserted to be a **different fact**, not a stand-in.

**What is still doable without it:** everything else in these three families — source work,
mock-provider stress, real DSH host runs with a controlled route, crash/durability tests, sandbox
tests, terminal qualification. That is the list the GAPS entry gives, and it is what this evidence
set covers.

### UPG-08 daily verdict — **NOT_READY**

The verdict is **computed** from the per-gate table in `upg-gates.test.ts`, so it cannot disagree
with the rows, and it is written to `UPG-08-verdict.txt` by the test itself so it survives this
process. The rule (spec UPG-08): any mandatory gate that is FAIL, NOT_RUN or BLOCKED_EXTERNAL forces
NOT_READY.

**8 of 24 are not PASS.** The blocking set, with its reproduction and its external blocker:

| gate | status | reproduction | why |
|---|---|---|---|
| SEC-01 | FAIL | `packages/dsh-daily-work/src/sec-gates.test.ts` (host-secret group) | a confined child reads outside the workspace under both modes; the seam has no read lever |
| SEC-03 | FAIL | `packages/dsh-daily-work/src/sec-gates.test.ts` (egress group) | a confined child completes a real HTTP round trip and connects to a LAN address; no egress boundary exists |
| SEC-06 | FAIL | `docs/GAPS.md#G-SEAM-21` + the import-graph scan in `upg-gates.test.ts` | the epoch guard has no production importer, so the field is inert |
| UPG-06 | FAIL | `packages/dsh-daily-work/src/upg-gates.test.ts` (GC group) | the spill sweep is age-based with no reference input and deletes a still-referenced artifact |
| DEP-04 | NOT_RUN | `qualification/results/M-DEP-SEC-UPG/FINDINGS.md` (this file) | no SSH execution world exists on this deployment; the SSH half cannot be run |
| SEC-08 | NOT_RUN | `docs/GAPS.md` | no execution-world-per-read-permission-domain exists; isolation is by separate store only |
| **UPG-07** | **BLOCKED_EXTERNAL** | `compatibility.lock.json` | **`live_provider_budget_authorized: false`** — no authorized budget for a real 30-provider run |
| UPG-08 | NOT_RUN | `qualification/results/M-DEP-SEC-UPG/UPG-08-verdict.txt` | this row: the verdict itself |

**The daily system must not be promoted.** Two of the four FAILs (SEC-01, SEC-03) are the platform's
read and egress boundaries, and the audit's own remedy is a dedicated Linux execution VM — not a
configuration change on this host. SEC-06 and UPG-06 are code-level gaps in this package. DEP-04 and
SEC-08 are NOT_RUN because the SSH execution world and the per-permission-domain execution world the
audit's production path requires do not exist here. UPG-07 is BLOCKED_EXTERNAL on a budget
authorization, and the gate's own text forbids substituting a mock for it.

---

## Cross-cutting notes

### One finding worth carrying forward

**DEP-03 and DEP-08 are the same defect measured from two sides, and it is the project's own
recorded lesson.** `tsconfig.json` excludes test files so the build never emits test code — correct
for the build, and it makes `tsc -p tsconfig.json` exit 0 with or without any test file present.
`tsconfig.check.json` exists for exactly that reason. DEP-03 measures the difference on the real
tree; DEP-08 proves the check config can actually go red. A gate whose oracle is weaker than its
scenario will pass while the product is broken (G-FIX-04).

The lesson is not hypothetical here: DEP-03's own first measurement was a FAIL, and the build config
exited 0 throughout. A suite that had measured only the build config would have reported a green
DEP-03 on an uncompilable tree.

### Measurement errors found and corrected during this work

Recorded because each would have produced a wrong finding:

1. **The "outside" directory for SEC-05 was under `os.tmpdir()`**, which `writableRoots()`
   explicitly GRANTS under `workspace-write`. The write succeeded — correctly, by policy — and would
   have read as a fence failure. Fixed by using a directory outside every granted root.
2. **`execFileSync` cannot run a `.CMD` on Windows**, so the first typecheck invocation returned
   `-1` — indistinguishable from a type error. Fixed by invoking `node <typescript/bin/tsc>`.
3. **The v2→v3 PTC admission rule is in `validation.ts`, not `payload.ts`.** The first assertion
   looked in the wrong module and would have read as a missing control.
4. **A `flat()` helper that stripped `*` characters ate markdown emphasis**, which would have let a
   claim in `docs/GAPS.md` be reworded while the assertion still passed. Fixed to strip only LEADING
   comment markers, including YAML's `#`.
5. **The `any`-bypass scan flagged a comment** that explains why an `as any`-shaped narrowing is NOT
   the forbidden bypass. Fixed to strip comments before scanning, so the claim is about code.

### What this evidence set does NOT establish

- **No live model turn was run.** `live_provider_budget_authorized` is false (UPG-07).
- **No SSH execution world.** DEP-04's SSH half is NOT_RUN; no remote world is claimed.
- **No kernel/data plane.** `packages/dsh-ipython/src/` is empty; SEC-06's park/reset half and any
  IPython gate belong to a later milestone.
- **DEP-03 was re-measured and now holds.** The tree compiled clean on three consecutive runs at
  the time of writing; the earlier failing state is recorded in `typecheck-errors.txt`. The tree is
  under concurrent construction, so a future run may find it red again — which the test would report
  as DEP-03 FAIL rather than absorb.
- **The install is a development `link:`,** not a published package (UPG-01's reach limit).

## Reproducing

```sh
cd /d/DSH/work/dsh-native-daily/packages/dsh-daily-work
export PATH="/d/DSH/tools/bin:/d/DSH/src/dsh-src/node_modules/.bin:$PATH"

# The three gate files (118 tests, ~35s with --maxWorkers=1).
npx vitest run src/dep-gates.test.ts src/sec-gates.test.ts src/upg-gates.test.ts \
  --maxWorkers=1 --no-file-parallelism

# The typecheck the gate is about. NOTE: the other config excludes tests and
# exits 0 — that is the false pass, not a pass.
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.check.json
node /d/DSH/src/dsh-src/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

`tsc.txt` records both runs. The check-config run is **not** clean and that is DEP-03's result; the
per-file attribution is in `typecheck-errors.txt`, and none of the errors is in a file this work
owns.
