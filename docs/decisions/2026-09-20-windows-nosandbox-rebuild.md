# 架构决策：Windows 无沙盒 + IPython 作为主执行面

> **状态：决策已定，执行计划如下。** 每一步标注"实测"或"待执行"。
> 决策依据见 `2026-09-20-sandbox-removal-plan.md`（影响评估）和本文（重建方案）。

---

## 0. 你的判断成立，且证据比预期更强

你说："因为有 IPython，所以应该很轻松，不需要直接面对 Windows 下的读写工具。"

**实测确认，三层证据：**

**证据 1 — IPython 从不经过沙盒。**
```
$ grep -rn "confine\|sandbox" packages/dsh-ipython/src/*.ts
(空)
$ grep -n "confine\|sandbox" packages/dsh-ipython/src/broker.py
(空)
```
`kernel.ts:191` 用 `subprocess.spawn()` 直接起进程；`broker.py:374-375` 用 `KernelManager(transport_encryption="required")` + `start_kernel()`。**整条链没有一次 `ctx.sandbox.confine()`。**

**证据 2 — IPython 工具直连内核，不碰 fs 工具。**
```ts
// packages/dsh-ipython/src/ipython-tool.ts:190
const result = await service.runCell(exec.agent, args.code, exec.signal)
```
`ipython` 工具（唯一参数 `code`）→ `service.runCell` → broker → ipykernel。**它不调用 `ctx.fs`，不调用 shell。**

**证据 3 — 纯 CPython 的文件 I/O 本来就无约束。**
```
$ cd /tmp && python -c "open('D:/DSH/work/dsh-native-daily/.probe-write-test.txt','w').write(...)"
WROTE outside cwd: D:/DSH/work/dsh-native-daily/.probe-write-test.txt
READ back: written by plain CPython, no DSH tools
cwd was: C:\Users\hzq00\AppData\Local\Temp
```
**写到了 cwd 之外，读回来了。** 这就是 IPython 单元格里的 Python 所拥有的能力。

**所以：模型的文件读写能力由 IPython 提供，而 IPython 从来不依赖沙盒。** 沙盒只约束 `pwsh` 和 `fs` 两个工具——它们可以被降级为辅助，而不是主执行面。

**WSL 已关闭**（`wsl.exe --shutdown`），`vmmemWSL` 内存已释放（原先占 1 GB）。

---

## 1. 重建方案：四个层面

### 层面 A — 关掉沙盒（"关"不是"删"）

**实测的"删"的后果（这是本方案最重要的依据）：**

删除 `sandbox` + `sandbox-policy` 两行后启动：
```
dsh: warning: 7 entries did not activate
  pwsh-sandbox: pending (waiting for services: sandbox, sandboxPolicy)
  ptc-runtime:  pending (waiting for services: fs, sandbox, sandboxPolicy)
  fs-sandbox:   pending (waiting for service: sandboxPolicy)
  permission:   pending (waiting for service: shell)
  terminal-controller / workspace-files / ui-deliverables: 同上
```
工具面结果：**`toolCount: 0`，`pwsh`/`ipython`/`work` 全部消失**，preset 挂载失败。

**根因**：`sandboxPolicy` 是被 7 个条目 `inject` 的**服务**。删掉它，这 7 个永远 `pending`，级联让 `shell`/`fs`/`ptcRuntime` 都不发布。

**正确做法——把 mode 设为 `danger-full-access`：**

```yaml
# profiles/daily-candidate/cordis.patch.yml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()   # 必须重述：patch 替换整个 config
- id: approval
  config:
    policy: never                        # danger-full-access 下官方 preset 就是 never
```

这是 DSH **官方一等公民路径**，不是 hack：
```ts
// packages/sandbox/sandbox/src/index.ts:31-32
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
// packages/shell/pwsh-sandbox/src/index.ts:99
if (mode === 'danger-full-access') { const result = await super.run(spec); ... }
```

### 层面 B — 把 IPython 提升为主执行面

这是你判断的核心。当前 profile 里 `ipython` 已经挂载且可用（实测 `toolCountAgentKey: 28`，含 `ipython`），但**它目前只是一个并列工具，不是"主执行面"**。要让它成为主执行面，需要：

| # | 动作 | 说明 |
|---|---|---|
| B1 | **系统提示词改写** | 告诉模型：文件读写、数据处理、计算、脚本执行**优先用 `ipython`**；`pwsh` 仅用于 IPython 无法表达的场景（交互式命令、进程管理）。这是"主执行面"的实际含义——**提示词决定了模型的行为** |
| B2 | **`ipython` 的内核工作目录** | 确认内核的 cwd 是项目根，而不是临时目录。`broker.py` 的 `start_kernel()` 需要传 `cwd`，否则 Python 的相对路径落在错误位置 |
| B3 | **保留 `fs` 工具但降级** | `read`/`write`/`edit` 工具仍应保留——它们是**结构化**的文件操作（带 offset/limit、精确替换），比 Python 手写 `open()` 更可靠。但**不再是唯一路径** |

**B1 是最关键的**：沙盒关掉之后，如果提示词还让模型"用 pwsh 做一切"，那模型仍会走 shell；只有提示词把 IPython 放在首位，它才成为主执行面。

### 层面 C — 删除 WSL 依赖（已完成一部分）

| # | 动作 | 状态 |
|---|---|---|
| C1 | `wsl.exe --shutdown` | **已完成**，`vmmemWSL` 已释放 |
| C2 | `sec-gates.test.ts` 的 WSL 探针 | **无需改** —— 实测它**优雅跳过**：`if (probe.status !== 0) { expect(...).toBe('SKIPPED — no POSIX sandbox runner on this host'); return }` |
| C3 | 任何"待建 WSL 沙盒"的待办 | **删除**（决策已定，不再是待办） |
| C4 | `docs/decisions/` 两份分析 | **保留**（决策依据） |

**注意**：C2 的两个探针测的是"POSIX 上沙盒能否读隔离"。关掉 WSL 后它们会报 SKIP 而非 FAIL——**这是正确行为**，因为它们测的是一个我们已经决定不用的机制。但它们**不应该被删除**：它们记录了"为什么 Windows 沙盒不够"的实测依据。

### 层面 D — 文档与身份

| # | 动作 |
|---|---|
| D1 | `DELETE-AUDIT.md` 新增条目：沙盒约束被**主动关闭**，附 6 门验收后果 |
| D2 | `GAPS.md` 的 `G-SEAM-12/24/25/28` 标注"**已被架构决策取代**" |
| D3 | `STATUS.md` 的 6 门改标"**永久不可达（架构决策）**"而非"未完成" |
| D4 | 重推部署身份（profile 改了，`host_profile_digest` 必变） |
| D5 | 同步 `eco.test.ts` 里 pin 的 profile digest（否则 ECO-07 会红） |

---

## 2. 6 门验收的最终处置

| 门 | 现状 | 决策后 | 处置 |
|---|---|---|---|
| SEC-01 host secret | FAIL（诚实） | **永久 FAIL** | 标"因架构决策不可达"。无沙盒下"两条路径都不可达"永远不成立 |
| SEC-03 外部网络 | FAIL（诚实） | **永久 FAIL** | 标"因架构决策不可达"。无 OS/网关边界 |
| SEC-08 角色变化 | NOT_RUN | **永久阻塞** | 标"前提消失"——单世界无域可迁移 |
| DEP-04 SSH路径一致 | NOT_RUN | **永久 NOT_RUN** | 标"前提消失"——无第二世界可混淆 |
| DEP-05 缺provider | PASS | **需重新表述** | 保留 `sandbox-policy` 行使此门仍有意义：区分"**显式配置的** danger-full-access"与"**静默降级来的**" |
| VER-04 host执行绕过 | FAIL（诚实） | **永久 FAIL** | 标"因架构决策不可达" |

**DEP-05 是唯一需要工程判断的一门。** 它的 oracle 是"不降为 danger-full-access"。我们**主动**设成 danger-full-access 之后，这句 oracle 需要重新表述为：**"配置中显式声明的 danger-full-access 是合法部署；provider 缺失导致的静默降级仍然必须失败"**。这两件事必须能区分——所以 `sandbox-policy` 行**必须保留**。

---

## 3. 执行顺序

**第 1 步：关沙盒（层面 A）**
- 改 `profiles/daily-candidate/cordis.patch.yml`，加 `sandbox-policy` + `approval` 两行
- 验证：`--dump-config` 确认 `mode: danger-full-access`
- **预期：0 entries did not activate**

**第 2 步：确认工具面完好（最关键）**
- 用 `verify-deliverable-surface` 探针从**外部 cwd** 启动
- 断言：`toolCountAgentKey: 28`、`pwsh`/`ipython`/`work` 都在、`error: null`
- **注意**：探针必须断言 `presetRoots` 是你启动的那个 home（G-FIX-13 的教训）

**第 3 步：验证 shell 真的不再受限**
- 让 `pwsh` 写一个工作区外文件 → **成功**（`workspace-write` 下会 EPERM）
- 这是"关掉"的**正面证据**，不是"没坏"的消极证据

**第 4 步：验证 IPython 是主执行面（层面 B）**
- 让 `ipython` 写一个工作区外文件 → **成功**
- 让 `ipython` 读一个工作区外文件 → **成功**
- 改系统提示词（B1），确认模型在提示词引导下优先选 `ipython`

**第 5 步：跑安全门，记录新的诚实状态**
- `vitest run src/sec-gates.test.ts src/security.test.ts src/security-denial.test.ts`
- **预期部分断言变红**——因为 oracle 假设了受限模式
- **这不是回归**。逐个判断：改成"无沙盒下行为如实"，还是标"该门已出界"
- **不许为了让测试变绿而弱化断言**

**第 6 步：重推身份（D4 + D5）**
- 重算 `host_profile_digest` → 重算 identity → `python qualification/runners/build-gates.py`
- 同步 `eco.test.ts` 的 pin

**第 7 步：文档（D1–D3）+ 提交**

---

## 4. 需要你确认

1. **接受"关而不删"**（层面 A）？实测证明"删"会让工具面归零。
2. **B1 提示词改写**是否要做？这是"IPython 成为主执行面"的**实际机制**——不做的话，沙盒虽关，模型行为不变。
3. **B2 内核 cwd**：希望内核的工作目录是项目根（`D:\DSH\work\<task>`）还是别处？
4. **第 5 步断言处置**：(a) 逐条改成"无沙盒下行为如实"，还是 (b) 整门标"已出界"不跑？我建议 **(a)**。
5. **验收规格动不动**？我建议**不动**——`acceptance_spec_sha256` 是身份输入，改它会让 85 条 PASS 全部作废重推。
