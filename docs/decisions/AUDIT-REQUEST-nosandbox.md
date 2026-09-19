# 审计请求：DSH 无沙盒架构（Windows + IPython 主执行面）

> **提交对象：GPT Pro 模型**
> **请求：审计本决策及其执行方案，指出错误、遗漏和更优路径。**
> **本文所有数字均为本机实测，非推断；每个断言标注来源。**

---

## 第一部分：本地现状（已实测）

### 1.1 部署身份

| 项 | 值 |
|---|---|
| upstream | `deepseek-ai/deepseek-harness` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`（`dsh-v0.1.6-alpha.2`） |
| 本地 checkout | `D:\DSH\src\dsh-src`（**钉住，未修改**） |
| 实现仓库 | `D:\DSH\work\dsh-native-daily`，branch `ipython-native`，56 commits |
| 构建后的 launcher（**唯一被认证的**） | `node apps/cli/lib/bin.js` |
| 部署身份 | `ece4037a9d5bbb014aa5a8395ed15531715a11949f2aa687166fcfeb5717576f` |
| 晋级决定 | `NOT_READY` |
| 模型平台 | Windows 11 (10.0.26200) AMD64，Node v24.18.0，pnpm 11.7.0 |

**身份的含义**：`compatibility.lock.json` 的 `deployment.identity` 是对 `deployment.inputs`（artifact sha256、lockfile、profile patch、preset、resolved graph、acceptance spec）的 sha256。**任何一项变化都会改变身份，并作废所有记录在旧身份下的 PASS。** 这是刻意设计。

### 1.2 门禁状态（两套独立编号）

**旧方案（104门，id `A01…J03`）** — `qualification/gates.json`：

| 状态 | 数量 |
|---|---|
| PASS | 85 |
| FAIL | 2（SEC-01、SEC-03，均为诚实 FAIL） |
| NOT_RUN | 10 |
| BLOCKED_EXTERNAL | 1 |
| NOT_APPLICABLE | 6 |

证据完整性：**127 条 evidence 引用全部重新哈希，127 匹配、0 陈旧、0 缺失。**

**新方案（112门，id `DEP-01…UPG-08`）** — `qualification/specs/acceptance-spec.json`：

**112 门全部 `NOT_RUN`，`evidence` 全为空。** 该文件从未重新生成。两套 id **完全不相交**。

> 我已建立映射报告：`qualification/results/MAIN-112-status/STATUS.md`。结论：112 门中 **92 门有证据文件具名引用**，20 门无。缺口分三类：(a) IPY 族 7 门是**编号缺口**（M11 有 12 需求表覆盖同样内容，54 测试）；(b) RES 5 门无法按 id 寻址；(c) **REC 族 7 门是真实缺口**，仅 REC-08 被提及且是在失败列表中。

### 1.3 实现规模

- 两个包：`packages/dsh-daily-work`（46 个测试文件）、`packages/dsh-ipython`（6 个测试文件）
- **1105 个测试用例被收集**（`vitest list`）
- 68 个证据目录（`qualification/results/`）

### 1.4 沙盒的实测行为（这是本次审计的核心事实）

**事实 A：Windows 沙盒只限写，不限读，也不限网。**

源码自述（`packages/sandbox/sandbox-windows-acl/src/index.ts:24-25`）：
> "writes are restricted; reads, network, and process visibility are NOT (WRITE_RESTRICTED intersects only write accesses)"

实测：一个受限子进程**原样读出**工作区外的金丝雀文件，exit 0，在 `read-only` 和 `workspace-write` 两种模式下都是如此；并能完成 loopback HTTP 往返和局域网 TCP 连接。

**事实 B：沙盒 seam 在类型层面无法表达读或网。**

```ts
// packages/sandbox/sandbox/src/index.ts:24-27
 * File-effect policy for confined processes. ... Network
 * and process visibility are outside this vocabulary.
```

`SandboxExecutionPolicy` 的成员只有 `mode`、`workspaceRoot`、可选 `sessionId`。四个候选杠杆全部探测过，**没有一个能限制读**；`runnerCommand` 是唯一真实的公共 seam，但它只能替换"哪个文件效果限制器"应用同一份 profile。

**事实 C：`danger-full-access` 是 DSH 官方一等公民路径。**

```ts
// packages/sandbox/sandbox/src/index.ts:31-32
/** A confining (non-`danger-full-access`) mode — the modes a SandboxPolicy can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

消费端有官方短路（`packages/shell/pwsh-sandbox/src/index.ts:99,136`、`bash-sandbox` 同构）：
```ts
if (mode === 'danger-full-access') {
  const result = await super.run(spec)          // 直接跑，不 wrap argv
  return { ...result, sandbox: { mode, denied: false } }
}
```

**事实 D：`ipython` 完全不经过沙盒。**

```
$ grep -rn "confine\|sandbox" packages/dsh-ipython/src/*.ts
(空)
$ grep -n "confine\|sandbox" packages/dsh-ipython/src/broker.py
(空)
```

链路：`ipython` 工具（唯一参数 `code`）→ `service.runCell()`（`ipython-tool.ts:190`）→ `broker.py` → `KernelManager(transport_encryption="required").start_kernel()`（`broker.py:374-375`）。**不调用 `ctx.fs`，不调用 shell，不调用 `ctx.sandbox.confine()`。**

已记录为 G-SEAM-25：kernel 有**自己的 pid**，但**未被 confine**，以**同一 OS 用户**运行，拥有与 host 相同的文件与网络访问。唯一约束是一份窄环境变量白名单和 `stdin: 'ignore'`。

**事实 E：纯 CPython 的文件 I/O 本就无约束。**

```
$ cd /tmp && python -c "open('D:/DSH/work/dsh-native-daily/.probe-write-test.txt','w').write(...)"
WROTE outside cwd: D:/DSH/work/dsh-native-daily/.probe-write-test.txt
READ back: written by plain CPython, no DSH tools
cwd was: C:\Users\hzq00\AppData\Local\Temp
```

**事实 F：删除沙盒行会让工具面归零（实测）。**

删除 `sandbox` + `sandbox-policy` 两行后启动：
```
dsh: warning: 7 entries did not activate
  pwsh-sandbox: pending (waiting for services: sandbox, sandboxPolicy)
  ptc-runtime:  pending (waiting for services: fs, sandbox, sandboxPolicy)
  fs-sandbox:   pending (waiting for service: sandboxPolicy)
  permission:   pending (waiting for service: shell)
  terminal-controller / workspace-files / ui-deliverables: 同上
```
工具面探针读回：
```
toolCount: 0
pwsh: false | ipython: false | work: false
error: preset "daily-standard" failed to mount: 5 row(s) did not activate:
  tool-pwsh: waiting for shell
  tool-fs: waiting for fs
  workflow-ptc: waiting for ptcRuntime, sandboxPolicy
  tool-workflow: waiting for workflowEngine
  present: waiting for fs
```

**根因**：`sandboxPolicy` 是被 7 个条目 `inject` 的**服务**，而 `inject` 是**就绪门**。删除 → 7 个条目永久 `pending` → `shell`/`fs`/`ptcRuntime` 不发布 → preset 的 5 个必需行不激活 → `mount.ts:396` 抛错 → **preset 整体挂载失败**，整个子树被 dispose。`ipython` 本身不依赖沙盒，它是**陪葬**的——preset 挂载是全有或全无。

**事实 G：WSL 可用，且 bwrap 真能做读隔离与网隔离。**

```
kernel: 6.18.33.2-microsoft-standard-WSL2
bubblewrap 0.11.1
user.max_user_namespaces = 144271

$ bwrap ... --unshare-net ... bash -c 'echo > /dev/tcp/1.1.1.1/80'
Network is unreachable                                  ← 网隔离生效

$ cat /tmp/secret-test/creds.txt                        ← 对照：bwrap 外可读
CANARY-SECRET
$ bwrap ... --tmpfs /tmp ... bash -c 'cat /tmp/secret-test/creds.txt'
No such file or directory                               ← 读隔离生效
```

**即：WSL+bwrap 能做到 Windows 沙盒在任何层面都无法表达的读隔离与网隔离。**

---

## 第二部分：需求（用户的决定）

用户明确要求：

1. **不使用沙盒。** DSH 运行在无沙盒模式。
2. **关掉 WSL**，所有东西在 Windows 无沙盒下重建。
3. **理由（用户的判断）**："因为有 IPython，所以应该很轻松，不需要直接面对 Windows 下的读写工具。"
4. 删掉沙盒相关的所有东西（后经实测澄清为"关"而非"删"，见事实 F）。

用户已确认："既然 DSH 官方支持（`danger-full-access`），那就 OK。"

---

## 第三部分：我提出的执行方案（请审计）

### 层面 A — 关沙盒（保留服务，设为 danger-full-access）

```yaml
# profiles/daily-candidate/cordis.patch.yml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()   # 必须重述：patch 替换整个 config 对象
- id: approval
  config:
    policy: never                        # danger-full-access 下官方 preset 即为 never
```

**保留 `sandbox-policy` 行而不删除**，因为：(a) 事实 F 证明删除会让工具面归零；(b) DEP-05 的 oracle 需要这行存在才有意义。

### 层面 B — 把 IPython 提升为主执行面

| # | 动作 | 理由 |
|---|---|---|
| B1 | **系统提示词改写**：文件读写/计算/脚本执行优先用 `ipython`；`pwsh` 仅用于 IPython 无法表达的场景 | 这是"主执行面"的**实际机制**——提示词决定模型行为。沙盒关了但提示词不变，模型仍会走 shell |
| B2 | 确认内核工作目录为项目根 | 否则 Python 相对路径落在错误位置 |
| B3 | 保留 `fs` 工具（`read`/`write`/`edit`）但降级为辅助 | 它们带 offset/limit 与精确替换，比手写 `open()` 更可靠 |

### 层面 C — 移除 WSL 依赖

| # | 动作 | 状态 |
|---|---|---|
| C1 | `wsl.exe --shutdown` | **已完成**，`vmmemWSL` 的 1 GB 已释放 |
| C2 | `sec-gates.test.ts` 的两个 WSL 探针 | **不改** — 实测它们优雅跳过（`SKIPPED — no POSIX sandbox runner on this host`）。**不删除**，因为它们记录了"为什么 Windows 沙盒不够"的实测依据 |
| C3 | 删除"待建 WSL 沙盒"的待办 | 决策已定 |

### 层面 D — 文档与身份

| # | 动作 |
|---|---|
| D1 | `DELETE-AUDIT.md` 新增条目：沙盒约束被**主动关闭**，附 6 门验收后果 |
| D2 | `GAPS.md` 的 G-SEAM-12/24/25/28 标注"**已被架构决策取代**" |
| D3 | `STATUS.md` 的 6 门改标"**永久不可达（架构决策）**"而非"未完成" |
| D4 | 重推部署身份（profile 改了，`host_profile_digest` 必变） |
| D5 | 同步 `packages/dsh-daily-work/src/eco.test.ts` 里 pin 的 profile digest（否则 ECO-07 会红） |

### 6 门验收的处置

| 门 | 现状 | 决策后 | 我的处置建议 |
|---|---|---|---|
| SEC-01 host secret | FAIL（诚实） | 永久 FAIL | 标"因架构决策不可达" |
| SEC-03 外部网络 | FAIL（诚实） | 永久 FAIL | 同上 |
| SEC-08 角色变化 | NOT_RUN | 永久阻塞 | 标"前提消失"——单世界无域可迁移 |
| DEP-04 SSH路径一致 | NOT_RUN | 永久 NOT_RUN | 标"前提消失"——无第二世界可混淆 |
| **DEP-05 缺provider** | **PASS** | **需重新表述** | **唯一需要工程判断的一门** |
| VER-04 host执行绕过 | FAIL（诚实） | 永久 FAIL | 标"因架构决策不可达" |

**DEP-05 的重新表述**：其 oracle 为"不降为 danger-full-access"。我们**主动**设为该值后，需改为区分两件事——"**配置中显式声明的** danger-full-access 是合法部署；**provider 缺失导致的静默降级**仍必须失败"。这也是 `sandbox-policy` 行必须保留的理由。

### 我建议不动验收规格

`acceptance_spec_sha256` 是**部署身份的输入**。改规格 → 身份再变 → 85 条 PASS 全部作废重推。且 pro 方案 `MASTER_EXECUTION_PLAN` M1 第 7 条已明文：

> **占位VM、无法建网络隔离或只能unsandboxed运行，均不得晋级为safe daily。**

所以取消沙盒**不改变晋级结论**（仍 `NOT_READY`），只改变**原因**：从"执行世界还没建"变为"我们决定不建，因此这 6 门永久出界"。

---

## 第四部分：请你审计的具体问题

### Q1 — 架构判断是否正确？
用户的判断是"有 IPython 就不需要面对 Windows 读写工具"。我的实测支持它（事实 D/E：IPython 从不经过沙盒，纯 CPython I/O 无约束）。**但这个判断是否遗漏了什么？** 具体：
- 模型通过 IPython 获得的文件能力，与通过 `fs`/`pwsh` 获得的，是否有**语义差异**（如 artifact 追踪、read 工具的分页、edit 的精确替换）会因"主执行面转移"而丢失？
- 是否有任何**正确性**（非安全性）依赖沙盒？例如 `fs-sandbox` 的符号链接/硬链接/rename 竞态处理——取消沙盒后，这些保护是否也一并消失，从而引入**功能缺陷**而非仅是安全边界变化？

### Q2 — 保留 `sandbox-policy` 行（设为 danger-full-access）是否是最佳做法？
替代方案是"删除所有沙盒行 + 在 `ptc-runtime`/`fs-sandbox` 等条目上去掉 `sandboxPolicy` 的 inject"。**后者是否更干净？** 代价是需要改 upstream 包（与"不修改钉住 checkout"约束冲突）或写 upstream 补丁。请评估。

### Q3 — DEP-05 的重新表述是否成立？（我已自查，答案见下，请复核）

我主张区分"显式配置的 danger-full-access"与"静默降级来的 danger-full-access"。**我已在源码中验证这个区分确实可观测**：

```ts
// packages/sandbox/sandbox-policy/src/index.ts:121,164-171
/** The deployment default mode — the fallback beneath a session override. */
readonly defaultMode: SandboxMode

resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
  const { session } = request
  return {
    mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode,
    workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
    ...session === undefined ? {} : { sessionId: session.id },
  }
}
```

**即存在三个可分别观测的值**：
1. `defaultMode` —— **部署配置**里声明的值（我们的 `danger-full-access` 在这里）
2. `overrideOf(session)` —— **运行期 session 事件**覆盖的值
3. `resolve()` 的返回 —— **实际生效**的值

所以"显式配置"与"实际生效"是**两个可区分的事实**，DEP-05 可以据此重新表述为：**"部署默认值是显式声明的（而非由 provider 缺失回退而来）；且任何 provider 缺失导致的静默降级仍必须抛 `SANDBOX_UNAVAILABLE` 而不是返回未 wrap 的 argv"**。

**请复核**：这个三值区分是否足以支撑 DEP-05 的重新表述？是否还需要一个"配置来源"标记（例如"这个值是用户写的还是回退默认的"）才能完全成立？注意 `Config` 的 schema 默认是 `'read-only'`（`:113`），所以"未配置"与"配置为 read-only"在 `defaultMode` 上**无法区分**——这可能是一个真实的观测缺口。

### Q4 — 6 门的处置是"标为永久不可达"还是"改规格为 NOT_APPLICABLE"？
我倾向不改规格（保住 85 条 PASS + 身份稳定）。但规格里**已有 `NOT_APPLICABLE` 先例**（条件性的 isolated writers 与专用 Jupyter 两组）。**哪个更诚实？** 请给出判断。

### Q5 — 是否有第三条路我没想到？
例如：
- 在**不建 VM** 的前提下，用 Windows 的 Job Object / AppContainer / WDAC 等机制提供读隔离？（我探测过四个沙盒 lever 全部失败，但那些是 DSH 暴露的 lever，不是 Windows 的原生能力。）
- 或者接受"无沙盒"但**缩小模型可触达面**（例如不挂 `pwsh`，只留 `ipython`）——这样"无沙盒"的风险面显著小于"无沙盒 + 全 shell"。

### Q6 — 事实 F 的处置是否有隐患？
"关而不删"依赖 `sandbox-policy` 服务继续发布。**如果未来 upstream 把 `sandboxPolicy` 改为可选、或把 `danger-full-access` 从 `SandboxMode` 移除，这个方案会静默失效吗？** 是否应加一个启动期断言来防止静默退化？

**我倾向加一个启动期断言，设计如下，请审计它是否足够**：

断言应检查三件事，任一不成立则**启动失败而非降级**：
1. `ctx.sandboxPolicy.resolve().mode === 'danger-full-access'` —— 确认实际生效值是我们要的（不是被 session 覆盖或回退成 schema 默认 `'read-only'`）
2. 模型可见工具面**包含 `ipython`** —— 事实 F 证明工具面归零是可能的，且归零时 preset 挂载会抛错，但**如果未来 upstream 改成软失败，工具面会静默变空**
3. `SANDBOX_UNAVAILABLE`（`packages/sandbox/sandbox/src/index.ts:124`）的抛出处仍然存在 —— 保证 DEP-05 的"静默降级必须失败"语义还在

**请评估**：这三个断言是否覆盖了静默退化的全部路径？是否应该做成一个**测试**（`vitest`）而不是启动期断言（避免给每次启动加成本）？两者都做的代价是什么？

### Q7 — 审计材料本身
本文是否有任何**未经证实的推断被当作事实陈述**？请指出。我特别关心：事实 A/B/C/D/E/F/G 中，哪些是**测量**，哪些是**源码阅读**，哪些是**推断**——我在文中已尽量标注，但请你复核。

---

## 附：证据位置

| 内容 | 路径 |
|---|---|
| 沙盒影响评估（三路线） | `docs/decisions/2026-09-20-sandbox-removal-plan.md` |
| 无沙盒重建方案（四层面） | `docs/decisions/2026-09-20-windows-nosandbox-rebuild.md` |
| WSL/bwrap 实测原始输出 | `qualification/results/MAIN-sandbox-path/MEASURED.txt` |
| 112 门状态映射 | `qualification/results/MAIN-112-status/STATUS.md` |
| 门禁清单（104门） | `qualification/gates.json` |
| 验收规格（112门） | `qualification/specs/acceptance-spec.json` |
| 已知缺陷与已修缺陷 | `docs/GAPS.md`（G-SEAM-01..28，G-FIX-01..13，G-VER-01..05） |
| 部署身份 | `compatibility.lock.json` |
