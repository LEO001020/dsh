# 调整方案：DSH 取消沙盒（无沙盒模式）

> **本文是执行计划，不是已完成记录。** 每一步都标注了它是实测的还是待执行的。
> **核心结论：不能"删掉"沙盒行，只能"关掉"它。** 这个区别是整个方案的关键，见 §1。

---

## 1. 先说最关键的一个实测发现：删 ≠ 关

你要求"把沙盒所有相关的都给删掉"。我实测了"删"的后果，**它会让整个模型工具面塌掉**。

**实测（删掉 `sandbox` 和 `sandbox-policy` 两行后启动）：**

```
dsh: warning: 7 entries did not activate
  pwsh-sandbox (@deepseek-ai/dsh-pwsh-sandbox): pending (waiting for services: sandbox, sandboxPolicy)
  ptc-runtime  (@deepseek-ai/dsh-ptc-runtime-node): pending (waiting for services: fs, sandbox, sandboxPolicy)
  fs-sandbox   (@deepseek-ai/dsh-fs-sandbox): pending (waiting for service: sandboxPolicy)
  permission   (@deepseek-ai/dsh-permission-presets): pending (waiting for service: shell)
  terminal-controller (@deepseek-ai/dsh-api-terminal-controller): pending (waiting for service: sandboxPolicy)
  workspace-files (@deepseek-ai/dsh-api-workspace-files): pending (waiting for services: fs, sandboxPolicy)
  ui-deliverables (@deepseek-ai/dsh-client-ui-deliverables): pending (waiting for services: workspaceFiles, fs, sandboxPolicy)
```

**再实测工具面（同一启动，探针读回的模型可见工具）：**

```
toolCount: 0
pwsh: false | ipython: false | work: false
error: preset "daily-standard" failed to mount: 5 row(s) did not activate:
  tool-pwsh: waiting for shell          ← 模型的 shell 没了
  tool-fs:   waiting for fs             ← 模型的文件读写没了
  present:   waiting for fs
  workflow-ptc: waiting for ptcRuntime, sandboxPolicy
  tool-workflow: waiting for workflowEngine
```

**根因**：`sandboxPolicy` 是一个被 7 个条目 `inject` 的**服务**，不是可选的装饰。删除它，这 7 个条目永远停在 `pending`，级联导致 `shell`、`fs`、`ptcRuntime` 都不发布，最终 preset 挂载失败、**工具面归零**。

受影响条目的 `inject` 声明（源码位置）：

| 条目 | inject | 位置 |
|---|---|---|
| `pwsh-sandbox` | `['subprocess', 'sandbox', 'sandboxPolicy']` | `packages/shell/pwsh-sandbox/src/index.ts:53` |
| `bash-sandbox` | `['subprocess', 'sandbox', 'sandboxPolicy']` | `packages/shell/bash-sandbox/src/index.ts:46` |
| `fs-sandbox` | `['sandboxPolicy']` | `packages/fs/fs-sandbox/src/index.ts:56` |
| `ptc-runtime-node` | 含 `sandbox`, `sandboxPolicy` | 实测 pending 列表 |
| `terminal-controller` | 含 `sandboxPolicy` | 实测 pending 列表 |
| `workspace-files` | 含 `sandboxPolicy` | 实测 pending 列表 |
| `ui-deliverables` | 含 `sandboxPolicy` | 实测 pending 列表 |

**结论：正确的做法是把 `sandbox-policy.mode` 设为 `danger-full-access`——服务仍然发布，但不再 confine 任何东西。** 这在 DSH 里是一等公民路径，不是 hack：

```ts
// packages/sandbox/sandbox/src/index.ts:31-32
/** A confining (non-`danger-full-access`) mode — the modes a SandboxPolicy can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

而消费端的官方短路：

```ts
// packages/shell/pwsh-sandbox/src/index.ts:99
if (mode === 'danger-full-access') {
  const result = await super.run(spec)      // 直接跑，不 wrap argv
  return { ...result, sandbox: { mode, denied: false } }
}
// :136
if (mode === 'danger-full-access') return super.start(spec)
```

`bash-sandbox` 同构。**所以"无沙盒模式"= 保留服务、把 mode 设为 danger-full-access，DSH 官方支持的路径。**

---

## 2. 需要调整的东西：逐项清单

### 2.1 必须改（不改则功能不对）

| # | 对象 | 现状 | 改成 | 为什么 |
|---|---|---|---|---|
| A1 | `profiles/daily-candidate/cordis.patch.yml` | 无 `sandbox-policy` 行 | 新增一行，`mode: danger-full-access` + **重述 `workspaceRoot`** | 关掉沙盒的唯一正确方式。**必须重述 `workspaceRoot`**，因为 patch 替换整个 config 对象（本仓库 TRAP 4） |
| A2 | 同上 | 无 `approval` 覆盖 | 新增一行，`policy: never` | `danger-full-access` 下官方 preset 是 `approval: never`。若不显式设置，会保留 `workspace-write` 时代的 `ask`，行为不一致 |

**A1 的确切内容**（`!!js` 是必需的，因为 `workspaceRoot` 是运行期值）：

```yaml
# DIFFERENCE 7: no sandbox. The mode is set to danger-full-access, which is
# DSH's own first-class path -- ConfinedSandboxMode EXCLUDES it by type
# (packages/sandbox/sandbox/src/index.ts:31-32), and pwsh-sandbox short-circuits
# on it (packages/shell/pwsh-sandbox/src/index.ts:99,136).
#
# WHY THE ROW IS KEPT AND NOT DELETED: sandboxPolicy is a SERVICE that seven
# entries inject. MEASURED: deleting it leaves 7 entries pending, cascades to
# shell/fs/ptcRuntime never publishing, the preset fails to mount, and the
# model's tool face goes to ZERO (toolCount: 0, pwsh/ipython/work all absent).
# Setting the mode disables confinement while keeping the service alive.
#
# workspaceRoot is RESTATED because a patch replaces the whole config object.
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
```

### 2.2 应当改（不改则文档与事实不符）

| # | 对象 | 现状 | 改成 | 为什么 |
|---|---|---|---|---|
| B1 | `docs/DELETE-AUDIT.md` | 无沙盒条目 | 新增条目：记录"沙盒约束被**主动关闭**"及其 6 门验收后果 | 这是**架构决策**，不是遗漏。删除审计正是记录这类事的地方 |
| B2 | `docs/GAPS.md` | G-SEAM-12/24/28 记沙盒缺陷为 OPEN | 在每条上加一句"**已由架构决策取代**"并指向本方案 | 否则读者以为这些是待修缺陷，实际是已决事实 |
| B3 | `qualification/results/MAIN-112-status/STATUS.md` | 6 门标为 FAIL/NOT_RUN | 6 门改标 `永久不可达（架构决策）` | "未完成"暗示以后会做；"因决策不可达"是已决事实 |
| B4 | `docs/DECISIONS/`（本目录） | 已有两份分析 | 保留，作为决策依据 | 方案和影响分析都要留档 |

### 2.3 需要你决定（涉及代价）

| # | 对象 | 问题 |
|---|---|---|
| C1 | `qualification/specs/acceptance-spec.json` | **动不动？** `acceptance_spec_sha256` 是**部署身份的输入**。改规格 → 身份变 → 85 条 PASS 全部作废重推。**我建议不动**（见 §3） |
| C2 | `compatibility.lock.json` | 若 A1 落地，`host_profile_digest` 必变 → 身份必变 → 必须重推 gates.json。**这一步无法避免**，因为 profile 改了 |

---

## 3. 我建议不动验收规格，理由

规格是 pro 模型给的**目标**。改它等于改目标，而不是完成目标。

- **不动规格**：6 门保持现状（3 FAIL / 2 NOT_RUN / 1 PASS），在决策文档里说明"主动范围缩减"。**85 条 PASS 保住，身份只因子项 C2 变更一次。**
- **动规格**：把 SEC-08/DEP-04 移入 `NOT_APPLICABLE`，语义更干净，但**身份再次变更、85 条 PASS 作废重推**。

而且 pro 方案 `MASTER_EXECUTION_PLAN` M1 第 7 条已经明文写了结果：

> **占位VM、无法建网络隔离或只能unsandboxed运行，均不得晋级为safe daily。**

所以取消沙盒**不改变晋级结论**——仍是 `NOT_READY`。它改变的是**原因**：从"执行世界还没建"变成"我们决定不建，因此这 6 门永久出界"。

**另外**：把这 6 门改成 `NOT_APPLICABLE` 在规格上其实是有先例的（条件性的 isolated writers 和专用 Jupyter 两组门就是这么标的）。所以这不是我为了让门好看而发明的类别——是规格自带的分类。如果你倾向改，我按 C1 走并先把身份重推成本算给你。

---

## 4. 执行顺序（含每步的验证）

**第 1 步：改 profile（A1 + A2）**
- 动作：给 `profiles/daily-candidate/cordis.patch.yml` 加 `sandbox-policy` 和 `approval` 两行
- 验证：`--dump-config` 确认 `mode: danger-full-access` 生效
- **实测预期**：0 entries did not activate

**第 2 步：确认工具面完好（这是最关键的一步）**
- 动作：用 `verify-deliverable-surface` 探针从**外部 cwd** 启动
- 验证：`toolCountAgentKey: 28`、`pwsh` 在列、`ipython` 在列、`work` 在列、`error: null`
- **理由**：这一步直接证伪了"删掉"的做法。如果这里不是 28，说明关的方式错了
- **注意**：探针必须断言 `presetRoots` 里是你启动的那个 home（G-FIX-13 的教训：固定输出路径的探针是共享可变资源）

**第 3 步：验证 shell 真的不再受限**
- 动作：让 `pwsh` 工具写一个工作区外的文件并读一个工作区外的文件
- 验证：**两者都成功**（在 `workspace-write` 下写会 EPERM）
- 理由：这是"关掉"的正面证据，不是"没坏"的消极证据

**第 4 步：跑安全门，记录新的诚实状态**
- 动作：`vitest run src/sec-gates.test.ts src/security.test.ts src/security-denial.test.ts`
- 验证：预期**部分断言会变红**，因为它们的 oracle 假设了受限模式
- **重要**：这不是回归，是 oracle 与新配置不符。**必须逐个判断**：断言应该改成"无沙盒下行为如实"，还是标记为"该门已出界"。**不许为了让测试变绿而弱化断言**

**第 5 步：重推身份**
- 动作：`node /tmp/reid.cjs` 式重算 `host_profile_digest` → 重算 identity → `python qualification/runners/build-gates.py`
- 验证：`grep -c "<新身份>" qualification/gates.json` = 85，旧身份 0 次
- **注意**：`packages/dsh-daily-work/src/eco.test.ts` 里 pin 了 profile digest，必须同步更新，否则 ECO-07 会红（这是 G-VER-01 记录过的同类问题）

**第 6 步：文档（B1–B3）**
- DELETE-AUDIT 新增沙盒决策条目
- GAPS 的 G-SEAM-12/24/28 标注"已被架构决策取代"
- STATUS.md 的 6 门改标"永久不可达（架构决策）"

**第 7 步：提交**
- 一个提交，消息里说明这是**架构决策**及 6 门后果

---

## 5. 回收站：哪些东西真的该丢

你说"丢回收站"。**要分清"DSH 的沙盒组件"和"我项目里的沙盒文档"**：

| 对象 | 处置 | 理由 |
|---|---|---|
| `D:\DSH\src\dsh-src` 里的 sandbox 包 | **不动** | 那是**钉住的 upstream 副本**（`ddefc45`）。改它=改 artifact identity，且用户约束明确"不修改钉住checkout" |
| `qualification/results/MAIN-sandbox-path/` | **保留** | 它是"为什么取消"的实测依据（bwrap 能读隔离的证据） |
| `docs/decisions/2026-09-20-sandbox-removal-plan.md` | **保留** | 决策依据 |
| `docs/decisions/2026-09-20-six-gate-impact-explained.md` | **保留** | 决策依据 |
| 我项目里任何"待建 WSL 沙盒"的待办 | **删除** | 决策已定，不再是待办 |
| `/tmp/ns.patch.yml` 等临时实验文件 | **删除** | 临时文件 |

**没有需要丢回收站的"沙盒代码"** ——因为沙盒是 upstream 的组件，我的项目里只有**配置和文档**。真正要"丢"的是**"以后要建沙盒"这个待办**。

---

## 6. 需要你确认

1. **接受"关而不删"**（§1 的实测结论）？这是唯一能让工具面活着的做法。
2. **验收规格动不动**（C1）？我建议不动，保住 85 条 PASS。
3. **第 4 步的断言处置**：当安全门变红时，你希望我 (a) 逐条改成"无沙盒下行为如实"，还是 (b) 整门标记"已出界"不再跑？我建议 (a) —— 保留测试的实际价值，而不是让它变成死代码。
