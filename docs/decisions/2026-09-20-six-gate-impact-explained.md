# 六门受影响验收的逐门讲解

**先更正我上一张表的一个错误。**我表里"现状"列混用了两套编号：SEC-01/SEC-03 等是**新112门方案**的 id，而我写的"FAIL（诚实）"取自**旧104门**（`E01`/`E06`）。核实结果：

```
$ node -e "..."   # 查本地 gates.json
SEC-01 不存在  SEC-03 不存在  SEC-08 不存在
DEP-04 不存在  DEP-05 不存在  VER-04 不存在
```

两套 id **完全不相交**（M10-shrink §4 已记录）。所以正确的说法是：

| 门（新112方案） | 新方案真实状态 | 旧104门对应物 | 旧门状态 |
|---|---|---|---|
| SEC-01 host secret | `NOT_RUN` | `E01` host凭证隔离 | **FAIL**（诚实） |
| SEC-03 外部网络 | `NOT_RUN` | `E06` network/egress | **FAIL**（诚实） |
| VER-04 host执行绕过 | `NOT_RUN` | `E12` 验证代码隔离 | `NOT_RUN` |
| DEP-04 SSH路径一致 | `NOT_RUN` | 无直接对应 | — |
| DEP-05 缺provider | `NOT_RUN` | 无直接对应 | — |
| SEC-08 角色变化 | `NOT_RUN` | 无直接对应 | — |

**新方案里这六门全部是 `NOT_RUN` 且 `evidence: []`。**旧门的 FAIL 是"测过且失败"，新门的 NOT_RUN 是"还没测"——取消沙盒会把后者从"待测"变成"不可达"，而前者的 FAIL 结论会被固化。

下面逐门讲。

---

## SEC-01 host secret

**原文 oracle**：`native read和Python直接读host HOME/DSH_HOME/proc` → **`两条路径都不可达；ro host root不是保密`**

**要什么**：两条读路径——(1) 原生 `read` 工具，(2) Python 直接读文件——**都**不能碰到 host 的 `HOME`/`DSH_HOME`/`/proc`。括号里那句 `ro host root不是保密` 是防作弊条款：**不许把 host root 只读挂载就宣称私密**，因为只读不等于读不到。

**为什么现在 FAIL**：实测过。一个受限子进程在 `read-only` 和 `workspace-write` **两种模式**下都成功读到了工作区外的 canary 文件，exit 0，内容逐字相符，包括伪造的 `HOME/.dsh/credentials.json`。四个候选杠杆全试过，**没有一个能限制读**（G-SEAM-12）。

**取消沙盒后的变化**：
- 现在：`workspace-write` 下**读**已经不可控，但**写**受 `WRITE_RESTRICTED` token 限制
- 取消后：**写也不受限**。读的失败结论不变，但"至少写是受控的"这个残余保证消失
- **为什么是"永久"**：这门的 oracle 是"两条路径都不可达"。取消沙盒是**主动选择让它们可达**。只要不建隔离域，无论怎么改代码都不可能满足。**不是"以后做"，是"已决定不做"**

**补充一个诚实的点**：ipython 这条路径**现在就已经**满足不了这门的反面——`kernel.ts:191` 无 confine，Python 可以直接读 host。所以这门的 FAIL 里，Python 那一半在 ipython 落地时就已注定。

---

## SEC-03 外部网络

**原文 oracle**：`DNS/IPv4/IPv6/局域网/cloud metadata访问` → **`未授权直连均受OS/网关阻断；记录真实结果`**

**要什么**：未授权的直连要**被 OS 或网关阻断**。注意措辞是 `OS/网关`——**不是** tool filter。括号 `记录真实结果` 是要求把真实测量写下来，不许用"理论上会被拦"代替。

**为什么现在 FAIL**：实测过。受限子进程完成了到 loopback 的真实 HTTP 往返，并**成功 CONNECT 到局域网地址**；DNS 能解析公网和私网名字。`web_fetch` 的 SSRF 过滤是真的、也测到了（127.0.0.1/::1/169.254.169.254/10.0.0.1 被拒），但**任何 shell 命令都能绕过它**——因为它只是那一个工具的 URL 过滤器。

**取消沙盒后的变化**：
- 现在：无网络隔离，但 SSRF 过滤覆盖 `web_fetch` 一个工具
- 取消后：SSRF 过滤**仍然存在**（它属于 `web-fetch-http`，不属沙盒），所以这门的实际能力**几乎不变**
- **为什么是"永久"**：oracle 要求 `OS/网关` 级阻断。`SandboxMode` 的文档原话就是"Network and process visibility are outside this vocabulary"——**这个 seam 从设计上就不表达网络**。取消沙盒只是把"设计上不表达"变成"明确不提供"

**这门最值得注意**：它其实是六门里**取消前后差别最小**的——因为现在也没有网络隔离。它的 FAIL 不因取消沙盒而恶化，只是不再有任何可能改善。

---

## SEC-08 角色变化

**原文 oracle**：`read权限域/项目变更后重用kernel` → **`必须新epoch/受控迁移；不带旧域秘密变量`**

**要什么**：当 kernel 的**读权限域**或项目变更时，复用它必须走 `新epoch` 或 `受控迁移`，且不能把旧域的秘密变量带过去。

**为什么是 NOT_RUN**：需要**两个不同的执行世界**才能测"跨域重用"。当前部署只配了一个（`executionWorld: local`），所以无域可跨。机制侧已确认：`kernel-lifecycle.ts:2122` 的 `changeReadPermissionDomain` 实现正确（顺序是 关闭准入 → 取消并清理 → 新epoch，`kernelEpoch: previousEpoch + 1`），**但它没有生产调用方，包也没导出它**（G-SEAM-25）。

**取消沙盒后的变化**：
- 这门从 `NOT_RUN`（"缺两个域，待建"）变成 **`NOT_RUN` 永久**（"已决定只有一个域，无域可跨"）
- 连带效应：`changeReadPermissionDomain` 那段的正确实现**永久失去意义**。它是个孤儿代码——实现正确、有测试、无调用方，而取消沙盒把它从"待接线"变成"永远不会接线"

**这是六门里唯一"取消沙盒直接删掉需求"的门**：不是做不到，而是**需求本身消失了**。诚实做法是把它标注为 `NOT_APPLICABLE — 架构决策：单执行世界`，而不是留在 `NOT_RUN` 让读者以为欠着工作。

---

## DEP-04 SSH路径一致

**原文 oracle**：`同一路径分别native read/grep/process/Web查看` → **`解析同executionWorld；不误读host同名文件`**

**要什么**：同一个路径字符串，经原生 `read`、`grep`、进程、Web 四个入口解析，必须落到**同一个执行世界**；不能出现"native 读 host 的同名文件、而进程读远端"这种混用。

**为什么是 NOT_RUN**：**这门的整个前提就是"存在多个执行世界"**。DSH 提供四个第一方 provider（`dsh-ssh`/`dsh-fs-ssh`/`dsh-sandbox-ssh`/`dsh-subprocess-ssh`），但**没有任何 shipped bundle patch 挂载它们**，所以部署里只有一个世界，"路径一致性"无从谈起——不是通过，是**没有可测对象**。

**取消沙盒后的变化**：
- 从 `NOT_RUN`（"缺 SSH 世界，待建"）变成 **永久 `NOT_RUN`**
- **更关键**：这门在单世界部署下**逻辑上恒真**（一个世界里"路径解析一致"是自明的），所以它变成了一个**空洞的 oracle**——留着它会误导读者以为需要验证

**建议**：标注 `NOT_APPLICABLE — 架构决策：单执行世界`。这与 SEC-08 同类。

---

## DEP-05 缺provider

**原文 oracle**：`移除subprocess/sandbox/SSH依赖` → **`loader失败明确；不降为danger-full-access`**

**要什么**：**移除** subprocess/sandbox/SSH 依赖后，loader 要**明确失败**，**不能静默降级到 `danger-full-access`**。这是防"悄悄失去约束"的守卫。

**这是六门里唯一语义会自相矛盾的门。**原因：

- 这门假设 `danger-full-access` 是**一个不该发生的降级**
- 取消沙盒的做法是**主动把配置设为 `danger-full-access`**
- 于是"不降为 danger-full-access"这个 oracle，在"配置本身就是 danger-full-access"的部署里**无法判定**——你没法区分"正常启动（因为配置就是 danger）"和"降级启动（因为 provider 缺失）"

**取消沙盒后的变化**：**不是 FAIL，是 oracle 失效。**这比 FAIL 更麻烦，因为它会让人误以为这门还能测。

**我建议的具体做法**（上一版规划里提过，这里给出理由）：
1. **保留 `sandbox-policy` 行**，设为 `danger-full-access`。删除该行会让 `SandboxUnavailableError` 失去配置来源，且让这门的"缺 provider"场景无法构造
2. 把这门的 oracle **改写**为它真正要守的东西：**"显式配置的 danger 与缺失 provider 导致的降级必须可区分"**。这是一个仍然有意义的性质——比如要求启动日志/解析图明确标注 danger 的来源
3. 如果不想改写 oracle，就标注 `NOT_APPLICABLE`。**但不能留在 NOT_RUN 假装还能测**

**注意**：改写 oracle 是敏感操作。本项目的铁律是"不通过改 oracle 取得 PASS"。这里改写**不是为了取得 PASS**，而是因为**原 oracle 在新架构下不可判定**。我会把它记录为"因架构变更导致 oracle 失效"，并保留原 oracle 原文在文档里供审计——这样读者能自己判断这次改写是否正当。

---

## VER-04 host执行绕过

**原文 oracle**：`candidate tests试读host secret/发送网络` → **`验证环境仍低权限，未授权操作被阻断`**

**要什么**：**验证环境**（跑 candidate 测试的那个环境）必须是低权限的；candidate 测试试图读 host secret 或发网络，必须被阻断。这是防"为了验证代码而把不可信代码跑在 host 上"。

**为什么是 NOT_RUN / 旧门 FAIL**：旧门 `E12` 记录 `NOT_RUN`，理由是"verifier 未构建"。而 R2 agent 刚重测过相关性质并**明确结论：没有公开 seam 能表达这个修复**——`SandboxPolicy` 只有 `mode`+`workspaceRoot`，上游自己的注释写着"Network and process visibility are outside this vocabulary"。

**取消沙盒后的变化**：
- 从"缺 verifier，待建"变成 **永久 FAIL**
- **这是六门里后果最严重的一门**，因为它守的是**验证链自身的完整性**：如果验证环境权限等于 host，那么"candidate 通过了验证"这个结论本身不可信——candidate 可以在验证时读走 secret 或改掉 oracle

**为什么它比 SEC-01 更严重**：SEC-01 守的是运行时隔离（模型不能读 host）；VER-04 守的是**元层面**——它保证 M8 那一整套 verification gates（VER-01..08，当前 45/45 PASS）的结论有效。取消沙盒后，**整个验证体系的可信度基础被移除**。

**这一点值得你特别权衡**：M8 的 45 个测试全过，但它们测试的是"验证机制是否正确"；VER-04 问的是"验证环境是否可信"。取消沙盒后，前者仍 PASS，后者永久 FAIL——**读者可能误以为"验证都过了"**。建议在 `STATUS.md` 里把这两者放在一起说明。

---

## 汇总：取消沙盒的四种后果，不是一种

我上一版把它们都写成"永久 FAIL"，这不准确。实际分四类：

| 类型 | 门 | 含义 | 诚实标注 |
|---|---|---|---|
| **A. 固化为 FAIL** | SEC-01、SEC-03 | 已测出失败，取消后无法改善 | `FAIL — 架构决策：无隔离域` |
| **B. 需求消失** | SEC-08、DEP-04 | 单世界下无测对象 | `NOT_APPLICABLE — 单执行世界` |
| **C. oracle 失效** | DEP-05 | 原 oracle 在新架构下不可判定 | 改写 oracle **并保留原文**，或标 `NOT_APPLICABLE` |
| **D. 元层可信度受损** | VER-04 | 验证环境权限=host，验证结论的基础被移除 | `FAIL — 需在验证章节显式说明` |

**这个分类本身就是取消沙盒的真实成本。**它比"6门FAIL"更准确，也更有用——因为它告诉你哪些是"做不到"、哪些是"不用做了"、哪些是"标准本身失效了"。

---

## 一个我必须提出的反对意见

你要的是轻量化，我理解并且认同方向。但我有责任指出**类别 D** 的特殊性：

**取消沙盒后，这个项目不再能声称任何形式的"安全边界"**——不只是模型不能读 host（那本来就做不到），而是**连"我们测过、我们知道边界在哪"这个主张都失去了基础**。因为测边界的环境和被测对象处于同一权限级。

这不是说不能取消。而是说**取消之后，`SECURITY.md` 和 `docs/INVARIANTS.md` 必须重写**：从"我们的边界是什么"改成"我们明确没有边界，这是决策"。留下前者会让读者以为有保证。

我在规划文档里建议的路线 1 依然成立，只是代价要按上面四类如实记录，而不是笼统的"6门FAIL"。

**等你确认路线，我再动配置。**目前我没有改任何东西。
