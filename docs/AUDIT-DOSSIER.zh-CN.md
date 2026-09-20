# DSH Native Daily — 对抗性审计报告

**提交给：** 独立审计方（GPT-Pro 级复核）
**撰写者：** 第三轮收尾的协调 agent
**日期：** 2026-09-21
**审计对象：** `https://github.com/LEO001020/dsh` @ `f019f67aa4b691151aa90036ef7e129eb929e48c`
**文档状态：** 本文所有数字，除明确标注为"引用自某写入者产物"者外，**均为撰写本文时重新实测**。没有任何数字来自记忆。凡依赖前序写入者产物的论断，均给出产物路径，供审计方自行复现。

---

## 0. 如何阅读本报告

"DSH 做完了吗"实际上是三个不同的问题，把它们混为一谈是误导读者最主要的方式：

| 问题 | 答案 | 位置 |
|---|---|---|
| **产品**对用户可用吗？ | **部分可用** | §3、§5 |
| **资格验证**完成了吗？ | **没有** —— `NOT_READY`，4 个强制 FAIL | §1 |
| **证据自洽**吗？ | **大体自洽** —— 一项检查报 315 个问题，但那是工作清单而非缺陷清单 | §2.4 |

**若只读一句话：** 发布门给出 `NOT_READY`，一个阻断项，4 个强制案例失败；而**这 4 个里有 3 个是记录在案的非缺陷，不是未修的工作**。第 4 个（IPY-13）失败在一个**词**上。

---

## 1. 发布门，完整输出

命令：`python qualification/runners/release-gate.py`
判决行：`RELEASE=NOT_READY blockers=1 candidate=152e5c45c4aef97b`

| # | 检查项 | 结果 | 明细 |
|---|---|---|---|
| 1 | verify-spec 通过 | **FAIL** | 315 个问题 —— *仅报告，不追加阻断项；见 §2.4* |
| 2 | 身份是新鲜的 | ok | 记录值 `152e5c45c4aef97b` == 重算值 |
| 3 | 无 FAIL | **FAIL** | 4 个：`CMP-04`、`IPY-13`、`REC-09`、`REC-10` |
| 4 | 无 FLAKY | ok | 无 |
| 5 | 强制案例中无 NOT_RUN | ok | 无 |
| 6 | 无 INVALIDATED | ok | 无 |
| 7 | 无陈旧证据 | ok | 无 |
| 8 | 仅白名单内的 BLOCKED_EXTERNAL | ok | 无越权 |
| 9 | 当前身份下的组装产品证据 | ok | 66 个组装产品 PASS 案例中，3 个带当前身份证据 |

状态计数（109 案例规格）：`PASS=104, FAIL=4, BLOCKED_EXTERNAL=1`。

**检查项 9 的 "ok" 高估了它建立的东西，必须精确读。** 该检查在**至少一个**组装产品 PASS 案例带当前身份证据时即通过。实测：**全规格只有四个案例带任何当前身份证据** —— `CMP-02`(PASS)、`BR-07`(PASS)、`CAP-10`(PASS)、`IPY-13`(FAIL)，所以 `3 of 66` 数的是三个 PASS。**其余 101 个 PASS 判决绑定在已被取代的身份 `0a0996f3` 上**，因此它们是历史证据，不是针对已发布产物的证据（§2.1）。

**审计方应抓的一处不一致：** `IPY-15` 的修复（§3.2）已在发布树中且判决为 PASS，但**它的证据条目未盖当前身份章**，所以它属于那 101 个之一。修复是真实且实测的；**章**落后了。我选择记录而不重盖章，理由见 §2.1。

**检查项 1 刻意不构成阻断项。** 门自己的文件头写明这一区分：verify-spec "在哈希错误时失败 —— 那是**归档**错误，可通过重新归档修复，对产品不说明任何事"；release-gate "在候选不可发布时失败"。我在源码中核实了：`release-gate.py:230-234` 追加一个 *check*，不追加 blocker。**审计方应把 315 当作工作清单，而非缺陷清单。**

---

## 2. 证据架构 —— 审计方最该施压的地方

### 2.1 身份问题：两套方案并存，其中一套已废弃

这是仓库中最容易导致错误审计结论的地方。

| 值 | 所在位置 | 是什么 |
|---|---|---|
| `152e5c45c4aef97b…` | `compatibility.lock.json` → `deployment.identity` | **已被取代**的方案；门的检查 2 与 9 与它比较 |
| `0a0996f3944b5528…` | 314 个证据条目 | 一个**真实的历史身份**，存在于锁自己的 `identity_history` 中 |
| `5146ee996bea2de8…` | 1 个证据条目（ID-06） | 生成的 BuildManifest 的**契约身份**（V5 §14） |
| `533c8cb0…`、`549732b5…`、`ece4037a…`、`73da4c62…`、`0ca14d4e…` | `identity_history` | 另外五个历史值 |

`helpers/rederive-identity.py` 在**每一次**运行开头都打印：

> THIS IDENTITY IS SUPERSEDED. V5 section 14 split it into: `compatibility.expected.json`（要求；本仓库任何文件的摘要都不在其中）；BuildManifest（生成物；`RuntimeDeploymentIdentity = H(canonical manifest)`）；结果/证据文件绑定到 `QualificationContractIdentity`。

**所以仓库中同时存在两套身份制度，而门用的是较旧的那套。** 生成的 manifest：

| manifest | `runtime_deployment_identity` | `qualification_contract_identity` | 案例数 |
|---|---|---|---|
| `trusted-local-v3.5146ee996bea` | `c969808e…` | `5146ee996bea…` | 110 |
| `trusted-local-v3.5bd8ee5b1809` | `0fe2d373…` | `5bd8ee5b1809…` | 110 |
| `trusted-local-v3.a091cb594902` | `c969808e…` | `a091cb594902…` | 110 |

注意前两个 manifest 共享 `runtime_deployment_identity` `c969808e…` 但契约身份不同 —— 这与声明的算法 `H(RuntimeDeploymentIdentity + acceptance_definition_digest + release_runner_digests)` 一致。

**我做了什么没做，以及为什么这对审计重要。** 我**没有**把那 314 个条目从 `0a0996f3` 重盖成 `152e5c45`。`0a0996f3` 在锁自己的历史中，所以那些条目是关于它们测量时那个产物的真实陈述。重盖章会声称一次测量是在当前产物上做的，而事实并非如此。**这是被禁止的动作**，而且一个靠重盖章变绿的门比一个保持红色的门更糟，因为红色至少是真的。诚实的补救是**重测**，本轮的九个案例接受的正是重测。

**由此暴露的一处具体缺陷：** `compatibility.lock.json` → `promotion.decision_reason` **在两处陈旧**，均已实测：
- 它指名两个已被取代的身份（`0a0996f3…` 与 `533c8cb0…`），且从未指名当前的 `152e5c45…`；
- 它的 `spec_sha256` 是 `e5b6a1d2481f39c5…`，那是**冻结的原始快照**的摘要，而 `spec_path` 指名的是**活动**规格，其摘要是 `635cb05a9a61b52f…`。

该段落甚至包含一段关于**同类缺陷先前实例**的自我更正（"this record previously named the SUPERSEDED identity … which is the same defect class as the stale pins it describes"）。**它是它所警告的那种缺陷的活标本。**

### 2.2 规格家族

| 文件 | sha256（前16） | 案例数 | 状态 |
|---|---|---|---|
| `qualification/specs/acceptance-spec.json` | `2fe95835425eb98e` | 112 | 全部 `NOT_RUN` |
| `qualification/specs/acceptance-spec.trusted-local-v1.json` | `635cb05a9a61b52f` | 109 | 104 PASS / 4 FAIL / 1 BLOCKED_EXTERNAL |
| `qualification/specs/frozen/acceptance-spec.trusted-local-v1.as-authored.json` | `e5b6a1d2481f39c5` | 109 | 全部 `NOT_RUN` |
| `qualification/specs/acceptance-spec.trusted-local-v2.definition.json` | `115aa092d0279c00` | 110 | 无 status 字段 |

**只有冻结快照与 112 案例规格是身份输入。** 我核实了活动 109 案例规格**不是**：`grep -c 'acceptance-spec.trusted-local-v1.json' helpers/rederive-identity.py` 返回 0。这就是本轮判决重测**没有移动身份**的原因。

### 2.3 109 案例规格按层分布

层的定义是规格自己的：T0 纯函数；T1 生产服务 + mock provider；T2 真实构建的 host/profile/preset 已启动；T3 真实子进程 kill + 真实磁盘恢复；T4 真实 OS 边界；T5 已授权的 live provider；T6 真实 coding/research 任务端到端。

| 层 | 总数 | PASS | FAIL | BLOCKED |
|---|---|---|---|---|
| T0 | 6 | 6 | 0 | 0 |
| T1 | 33 | 32 | 1 | 0 |
| T2 | 56 | 54 | 2 | 0 |
| T3 | 10 | 9 | 1 | 0 |
| T4 | 3 | 3 | 0 | 0 |
| T5 | 1 | 0 | 0 | 1 |

**T6 有零个案例。** 规格定义的最强层 —— "真实 coding 或 research 任务端到端" —— 是空的，而发布门的检查 9 选择 `{T2, T3, T4, T6}`，所以 T6 对它 66 的分母毫无贡献。

各层证据条目数：T0 18，T1 113，T2 158，T3 29，T4 6，T5 0。合计 324 条；314 条带 `0a0996f3`，6 条带 `152e5c45`，3 条不带，1 条带 `5146ee996bea`。

### 2.4 315 个 verify-spec 问题，精确分解

算术预测并已确认：**每一条身份与锁当前值 `152e5c45` 不同的证据条目都会被标记。**

| 数量 | 种类 |
|---|---|
| 314 | 身份章 `0a0996f3944b5528…` —— 一个**真实的历史身份**，在 `identity_history` 中 |
| 1 | 身份章 `5146ee996bea2de8…` —— 契约身份，在 `ID-06` 的新证据上 |
| **315** | 合计 |

**零个摘要不匹配。零个文件缺失。零个其他种类。** 这是一个干净的分解：315 完全来自两套身份制度之间的一处归档约定落差。

### 2.5 112 案例权威规格是**另一套**案例集

用户的审计包（`delivery/acceptance-spec.json`）与仓库的 `qualification/specs/acceptance-spec.json` **逐字节相同**：112 案例，全部 mandatory，全部 `NOT_RUN`，层分布 `integration 72 / fault_injection 16 / security 16 / evaluation 8`，`hard_child_capacity: 30`，`target_range: [1,30]`，家族 `DEP IPY BRG DAT WEB HIS REC SEC CAP UI VER ECO RES UPG` 各 8 个。

**两套规格无法按 `id` 连接。** 109 案例规格的家族是 `BR CAP CMP DATA FS ID IPY OBS REC RES VER` —— 只有 `CAP IPY REC RES VER` 重叠，而且即便在那里，编号也是各自独立编写的（`CAP-01..08` vs `CAP-01..13`）。按家族连接只是猜测。

逐案例盘点见 `qualification/results/C9-coverage/COVERAGE.md`（写入者 c9 产出）：

| 层 | 总数 | COVERED | PARTIAL | UNCOVERED | BLOCKED_EXTERNAL |
|---|---|---|---|---|---|
| integration | 72 | 57 | 9 | 3 | 3 |
| fault_injection | 16 | 6 | 8 | 2 | 0 |
| security | 16 | 11 | 4 | 0 | 1 |
| evaluation | 8 | 2 | 4 | 0 | 2 |
| **合计** | **112** | **76** | **25** | **5** | **6** |

**c9 记录的三项限定，比 76 这个数字本身更重要：**

1. **大量证据是在低于其标签的层上测的。** 许多强结果跑的是真实服务配**受控模型适配器**（provider 边界处）。这对机械 oracle 是诚实的，但**不等于**"真实用户动作在出厂 profile 上驱动了它"。
2. **COVERED 的意思是"某产物建立了这个 oracle"，不是"产品已合格"。**
3. 可达性区分在具体行上可见：`REC-06/07/08` 与 `RES-04/06` 是 PARTIAL，正因为其机制位于 `kernel-lifecycle.ts`，而该模块**没有非测试导入者**。

c9 还**更正了一个先前的计数**：`MAIN-112-status/STATUS.md` 报告 92 个案例被证据文件"点名"。那是机械字符串匹配，它同样会匹配到 *"什么**没有**被证明"* 清单里的案例 id。**读断言得到 76。**

6 个 BLOCKED_EXTERNAL 分两类：**4 个需要用户没有的 live provider 预算**（`IPY-08`、`ECO-07`、`ECO-08`、`UPG-07` —— 后者 oracle 明写 mock 结果不替代本门）；**2 个需要"被供给的世界"而非预算**（`DEP-04` 无 SSH 执行世界挂载；`SEC-08` 需要两个读权限域，本部署只有一个）。

---

## 3. 4 个 FAIL，以及另外九个发生了什么

### 3.1 剩余的四个

| 案例 | 层 | 为何不是产品缺陷 |
|---|---|---|
| `CMP-04` | T2 | **规格自相矛盾，已验证为真。** 其 oracle 要求 `toolCountAgentKey is 28` 且 `pwsh is present`；`CMP-13` 要求 `pwsh` 缺席，并在**同一次测量**上 PASS。写入者 c6 用三种方式检验了"这是测量假象"这一替代解释并推翻之：8 个带名字集合的 28 值测量**全部**含 `pwsh`；无其他 key 或 cwd 能复现；既有对照重新启用该行后**恰好**因加入 `pwsh` 而从 27→28。**取代方案已经被行使过一次** —— D1 决定下的 v2 定义把 CMP-04 记为 `rewritten`，`dropped_assertions: ["toolCountAgentKey is 28", "pwsh is present"]`。再次取代会让 109 个判决第二次失效，只为修一个注记。 |
| `REC-09` | T3 | **守卫是被删除的，不是被搁置未接线的**（G-SEAM-21）。`recovery.ts` 现在只导出 `RelaunchOutcome` 与 `relaunchPrepared`；其自身注释记录它"曾经还导出过一个结算守卫：`WorkerSettlement`、`applyWorkerSettlement`，以及一个基于独立 `dsh_daily_work_refusals` 域的 `RefusalLedger`"。两个测试强制这次删除（`durability-advanced.test.ts:867`、`upg-gates.test.ts:1820`）。引自 GAPS：该守卫的输入"在任何生产路径上都无法构造（没有生产调用点写入终态；`unknown` 没有生产出口）"。**接线它等于为了满足 oracle 而制造一个调用者** —— 本项目记录最多的反模式。 |
| `REC-10` | T1 | 同一次删除；本案要求一个已不存在的机制的可达性。 |
| `IPY-13` | T2 | **失败在一个词上。** 记录在案的缺陷已消失，产品行为可以说**优于** oracle 所要求的 —— 但 oracle 的字面要求是 `undecidable`，而产品报告的是 `known-late` 并带真实来源 cell id。**oracle 不会被一个它没有预见的更好结果所满足。** |

### 3.2 移动的九个，每个都附其仪器

| 案例 | 记录的 FAIL | 测量 | 独立核验 |
|---|---|---|---|
| `ID-06` | 固定检出点脏 | **CRLF 假象。** HEAD blob 7086 字节纯 LF；工作区文件 7251 字节纯 CRLF；差恰好 165 字节 = 每行一字节。`git hash-object` == `git rev-parse HEAD:<path>`。`.gitattributes` 规定 `eol=lf`；`core.autocrlf=true` 是宿主覆盖 | `check-source-plane.mjs` 现退出 0："source plane: CLEAN"；`build-manifest.py --check-expected`："every requirement in compatibility.expected.json holds" |
| `ID-01` | 223 个说明符中 1 个解析到 `lib/` 之外 | **那次 boot 测的是另一个检出点。** offender 自己记录的 `parentURL` 是 `file:///D:/DSH/work/dsh-native-daily/...` —— 主检出点，位于分支 `ipython-native`，**从未收到修复 `bcc036e`**（`git merge-base --is-ancestor bcc036e HEAD` → NO）。时间线吻合：证据 08:02 提交，修复 10:10 编写 | 合格树中 `artifacts.ts:131` 导入公开的 `@deepseek-ai/dsh-attachment`；`grep '^import.*attachment-local'` 遍历构建后的 `lib/artifacts.js` **返回空**；`no-src-imports.test.ts` 5/5。写入者 c4 复现为 **0 个 offender、17/17**，并带**否定对照**（注入 offender → FAIL，且 parent 路径是本 worktree 自己的） |
| `ID-05` | 475 个非测试 `as never` | **零。** 两个探针**各自独立**写下 `apply(toolCtx as never)` —— 同一形状出现两次，正是"**缺少接缝**"的信号。加入 `IpythonToolMount` / `IpythonToolService`（`KernelService` 的一个 `Pick`，只指名 `execute` 触及的四个成员）与 `registerIpythonTool`；`apply(ctx)` 委托给它 | 删掉 cast 后**立刻暴露出两个被掩盖的真类型错误**（`runCell` 返回 `Promise<unknown>` 而要求 `Promise<CellResult>`；`ArmOutcome.result` 被标为 `unknown`）。两者已修且现在**受检**。`typecheck: PASS`，基线 0 |
| `CMP-02` | sandbox 行解析为 `workspace-write` | **`danger-full-access`**，三个子句全中，真实 boot | **否定对照**：把 mode 改回缺陷值，**同一仪器**翻转为 `STILL FAILS`，`ptcConfineDecision: WOULD CONFINDE` |
| `BR-07` | bridge 路由无 per-call 处置词汇 | 词汇存在且可达；**原始探针未加修改**重跑，两个词汇布尔量翻转，而 drain 时序不变（1514 ms） | r5 产品 bridge 套件 10/10：`cancelled`、`abandoned-unstarted`、`handed-to-jobs` 带 `jobId: "job-77"` |
| `CAP-10` | 完成风暴下 `drain` 超额 | **当初测出该缺陷的同一个 V8 探针臂**现读 `admitted=2 heldAgainstTarget3=3 deficitAfter=0`（原为 `admitted=3`） | 风暴套件补：对照臂（`admitted=6 held=6 overshoot=0`）、N+2 对 N（`admitted=6 launches=12 highWater=6`）、重复臂、以及 10 中释放 3/5/10 的扫描，全部 `overshoot=0`。7/7 |
| `IPY-15` | 丢帧计数器零调用点 | 损失**比记录的更严重**，且**有两条**损失路径：(a) cell 结算后一次 4,456,448 字节后台写入让 iopub pump 内 `encode_frame` 抛错，pump 的裸 `except Exception` 吞掉它 —— 4.4 MB 消失，模型一无所知；(b) 超限 reply 在**出厂 256 KiB cap** 下就可达 —— 200 × 64 KiB `display()` → **13,118,726 字节** reply，所以它不是"只有调高上限才出现"的奇观 | 拒绝文本现为 `FRAME_TOO_LARGE: N frame(s) LOST; frame of … exceeds the limit; declared … bytes, limit … bytes; the cell ran and its result was not delivered` —— **它声明字节丢了**，而不只是声明超了界。`noteDroppedFrameDefinitionCount` 0→1；`transportDroppedFrames` 声明在宿主的 `KernelStatus` 类型上。**变异测试**：把 reply 退回裸 `str(exc)` 会让门变红，随后恢复 |
| `DATA-09` | 两个阶段无生产者，故子句不可能成立 | 记录的推理**混淆了刺激与 oracle**。真正的缺陷：`captureFile` 对每个 range 请求把缺口强制为 0，所以 400 字节文件以 `length: 1000` 读取时报告 `complete-within-request`、`gaps: []`、`isDeliverableAsComplete: true`，**而 600 字节缺失** | 前后对比：`partial, native-acquisition/none, deliverable FALSE`。对照臂（range 落在文件内）不变。新 pin 被**反证**（对回退构建 1 failed / 47 passed） |
| `DATA-11` | 游标从外部 store 产出页 | 点名的臂已成立；**危害**仍可达，因为身份备忘盖在 `(size, mtimeMs)` 上，**两者都可被攻击者设置**。加入 `ctimeMs` 关闭它 | before 臂复现出**审计归档的确切摘要**（`cc7321cc…`）；after：`artifact-integrity-error`。pin 被**反证**（1 failed / 37 passed） |

---

## 4. 工具面 —— 实测，非阅读文档

本节按要求专门测量，数据来自真实 boot，不来自文档。

### 4.1 模型的有效面：**24 个工具**

由写入者 c6 通过真实 boot 测得，探针**不插入任何 tool 行**（`qualification/results/C6-spec/c6-verdict.json`，`ranAt 2026-09-20T15:24:08Z`，cwd `C:/`，`probeAddsToolRow: false`，`error: null`）：

```
ask_user_question  create_goal  edit      exit_plan_mode  get_goal
glob               grep         interrupt_agent        ipython
job_kill           job_list     job_output             list_agents
present            read         read_image             send_message
skill              todo_write   update_goal            web_fetch
web_search         work         write
```

`toolCountAgentKey: 24`，`ipythonToolPresent: true`，`workToolPresent: true`，`error: null`。在**三条不同 cwd 的臂**上复现，结果**完全一致**：非仓库 cwd（`D:/DSH/work/c6-foreign-cwd`）、仓库根 cwd（`D:/DSH/work/wt-c6`）、以及默认臂。每条臂的 `toolCountContextKey: 0` 与 `toolCountGlobalKey: 0` —— 该面是**按 agent 键控**的，不是按 context 或 global 键控。

### 4.2 产生它的 preset 行

来自 `profiles/daily-candidate/presets/daily-standard/agent.cordis.yml` —— 共 **35 行**，逐行解析：

**无条件禁用（9 行）：**

| 行 | 原因 |
|---|---|
| `tool-pwsh` | IPython 是模型唯一的执行面（提交 `35c829d`） |
| `tool-subagent` | 面向模型的子进程创建被移除（提交 `d8b95cb`，P0.7） |
| `tool-subagent-fork` | 同上 |
| `tool-subagent-codex` | 同上 |
| `tool-subagent-claude-code` | 同上 |
| `workflow-ptc` | 与 `tool-workflow` **在同一次编辑**中禁用，因为 `tool-workflow` 会 inject 它 —— 只禁一个会让另一个永久 pending |
| `tool-workflow` | 同上 |
| `tool-ralph` | 不属于本部署的面 |
| `tool-plugin-manager` | 模型不得管理插件 |

**启用或条件性启用（26 行）：** `persona`、`agent-instructions`、`tool-bash`、`tool-fs`、`tool-fs-search`、`tool-jobs`、`skill-filesystem`、`tool-skill`、`command-goal`、`tool-goal`、`planning`、`plan-mode`、`compaction`、`compaction-basic`、`command-compact`、`tool-result-pruner`、`delegation`、`tool-subagent-control`、`tool-subagent-list-agents`、`tool-ask-user`、`tool-todo`、`tool-web`、`present`、`daily-work-tools`、`daily-work-command`、`ipython-tool`。

### 4.3 有一行是**宿主相关表达式**，在本机解析为**禁用**

`tool-bash` 带 `disabled: !!js process.platform === 'win32'`。本机 `process.platform` 是 `win32`，所以 **`tool-bash` 是禁用的**。其出厂形态在非 Windows 上启用它，这就是该行被保留为声明而非删除的原因。

**审计方注意：** 这是一个真实的移植性事实，且有后果 —— **在 Linux 宿主上面会是 25 个工具**，`bash` 会出现。**24 这个数字是关于*本*宿主的陈述。**

**preset 自己对"为何保留出厂形态"的论证值得作为方法论陈述来读**，因为它是本项目把规则应用于自身：

> 为何 `tool-bash` 完全保留出厂形态。其出厂表达式在 POSIX 上启用它，而本部署是 Windows，所以该行在这里无论哪种方式都是惰性的。改动它就会是一个**没有 POSIX 证据支撑的 POSIX 主张** —— 本仓库记为 G-FIX-04 的那种"未经测量的主张"失效。

所以这种不对称是刻意的：**不**把它硬禁用，因为硬禁用会断言一件本部署从未测量过的关于 POSIX 的事。**若审计方认为该行应无条件 `disabled: true`，那就得同时接受它由此变成一个未经测量的 POSIX 主张。**

**还要注意 shell 行**不**控制什么。** preset 声明 `shell` **服务**不受该行影响 —— 它由宿主平面 executor 行提供（`pwsh-sandbox`/`bash-sandbox`，由 `@deepseek-ai/dsh-base` 挂载），消费它的宿主行（terminal 控制器、权限栈）继续解析它。**preset 只决定 *agent* 是否拿到面向模型的 shell 工具。** 把"tool-bash 被禁用"读成"进程里没有 shell"是错的。

### 4.4 为什么宿主 dump 里 17 个 `tool-*` 行读作 `disabled: true`，而面上有 24 个工具

一次真实 `--dump-config` 显示全部 17 个宿主平面 `tool-*` 行都是 `disabled: true`。这**不是**矛盾，preset 自己的注释说明了原因：

> **编辑 `profiles/daily-candidate/cordis.patch.yml` 无法改变模型的工具面。** 那个 patch 拥有宿主平面（roster、subagent 容量覆盖、sandbox 与 approval 行）。**这个文件拥有模型所见的东西。**

preset **重新声明**这些行并给出它想要的禁用状态，而 **preset 才是模型读的**。只读宿主平面 dump 的审计者会得出"面是空的"的结论；只读 preset 的审计者会漏掉宿主平面。**两个平面都必须读。**

### 4.5 缺席的，每一个缺席都是刻意的

| 缺席 | 机制 | 后果 |
|---|---|---|
| `pwsh`、`bash`、`shell`、`run_code` | preset 中禁用 / 宿主相关 | **IPython 是模型唯一的执行面** |
| `subagent`、`subagent_fork`、`workflow` | 四行被禁用（`d8b95cb`） | 模型不能直接创建子进程；它走 `work` |
| `terminal_*`（六个工具） | `dsh-tool-terminal` **没有任何**出厂 preset 挂载（G-SEAM-17，OPEN） | 人类 `terminalController` 永远不是模型能力 —— 这是**刻意的安全属性** |
| 任何 `data.*` 工具 | `dataToolNames` 是 `[]`（写入者 c3 实测） | 模型**无法**把 `data.pages` 当作原生工具触及；data 平面可作为**服务**可达，但不可作为**工具** |

**审计方应权衡的两个后果：**

1. `ipython` 是唯一执行面，这**抬高**了 IPython 桥的风险权重。G-SEAM-34（"IPython 原生工具桥位于每个包入口的传递闭包之外"）记为 **RESOLVED** —— `new BridgeServer(...)` 现构造于 `packages/dsh-ipython/src/kernel-plugin.ts`，且我端到端核实了真实 cell 调用真实 DSH 工具：`bridge-seam.test.ts` **17/17**，包括"a cell calling `dsh.call` lands in the real ToolRuntime pipeline, and the value comes back"与"N nested calls produce N dispatches and N results, with no turn taken by the bridge"。
2. `work` 存在但**无 run 时抛错**：实测 `"this session has no active run; a run is created by user authorization"`（`runReachable: false`）。G-SEAM-31 记为 **RESOLVED** —— `src/command-work.ts` 注册 `/work start [N]` 作为人类授权路径。所以**模型不能单方面启动子工作；人类命令才创建 run**。**这是一条刻意的权限边界，不是 bug** —— 但它意味着强制的 N=10 滚动补位**无法仅由模型动作触及**。

### 4.6 容量：实测在生产中具有约束力

`qualification/results/T10-capacity/prod-capacity-report.json` —— **17/17 检查，verdict PASS**，在真实 boot 上：

- "the ledger limit is the deployment constant 30" → `30`
- "a real child was created through the model-facing seam" → `childId="e9e2931f-…" error=null`
- "THE GUARD IS LIVE: the ledger recorded the child (delta 0 → 1)"
- "**THE CAP IS BINDING IN PRODUCTION**: a real creation call was REFUSED at 30" → 拒绝文本指名部署常量
- "the refusal never raised occupancy above 30" → `occupied=30 highWater=30`
- "releasing the filler returns the ledger to its pre-boundary state"
- "**G-SEAM-19 CLOSED IN PRODUCT**: a one-shot child TAKES a host slot" → `started=true liveChildren=2`

**关于此主题仍然 OPEN 的，如实陈述而非粉饰（G-SEAM-19）：** DSH 自己的池是 `rootPools = new WeakMap<Agent, ActivationPool>()` —— **按 root 而非按 host**。**host 界是本项目的 `mountChildAdmissionGuard` 台账，不是 DSH 的池。** 另外 `workflow-ptc` 的 `startChild` 不传 `maxDepth`，所以它虽然不再逃出**容量**上限，**仍逃出部署的深度天花板**。

**G-SEAM-18（OPEN）：** `resolveChildDepth(parent, request.maxDepth)` 把调用方给的值当作绝对上限，所以 `maxDepth: 99` 会**抬高**部署上限，而且**省略 `maxDepth` 与 99 等效**。本项目自己的路径不受影响（`launch-port.ts` 硬编码 `maxDepth: deps.maxDepth`），但 workflow/PTC 路径受影响。

---

## 5. 41 条严格 OPEN 的 GAPS 条目，已分类

`docs/GAPS.md` 有 95 行。严格只计状态列**以** `OPEN` **开头**的行（排除已解决行里的 "was: OPEN"）：**41 条**。

| 数量 | 种类 | ids |
|---|---|---|
| 33 | 产品/证据缺口 | 03 04 05 06 13 16 18 24 25 26 27 28 39 43 44 50 51 52 53 58 59 61 63 65 66 68 69 70 76 77 78 79 80 |
| 4 | 上游（DSH 行为，非本部署） | 07 12 22 23 |
| 1 | 设计约束（已接受） | 10 |
| 1 | 明确阻断某项主张的产品缺口 | 19 |
| 1 | 重复条目 | 17 |
| 1 | 规格缺陷（非产品缺陷） | 46 |

**33 条中最具后果的**，附机制：

- **G-SEAM-44** —— `kernel-lifecycle.ts` 本身不可达，所以**三个 PASS 的 RECOVERY 案例是关于机制的陈述，而非关于产品的陈述**。由 `import-graph.mjs` 实测：`dsh-daily-work` 中 **33 个可达 / 8 个不可达**非测试模块；不可达集合含 `durability-runner.ts`、`effects.ts`、`kernel-lifecycle.ts`、`perf-metrics.ts`、`reconcile.ts`。
- **G-SEAM-80** —— `environmentDigest` 是**路径字符串**的摘要：`sha256(\`${pythonExecutable}\u0000${platform}\u0000${arch}\`).slice(0,16)`。通过真实 `KernelService.identityFor` 实测六条臂：把 `brokerScript` 指向另一个文件，摘要不变；同一目录下 `pythonw.exe` 与 `python.exe` 产生不同摘要；`DSH_PYTHON` 用反斜杠或大写拼写会哈希出不同值。
- **G-SEAM-79** —— 任意进程中的**第二个** Session 会静默拿到**内存** bridge 台账，所以耐久性损失是常规事件，而非"存储失败时才有"。
- **G-SEAM-24** —— sandbox 接缝**没有任何网络词汇**；固定检出点声明这是刻意的延后。
- **G-SEAM-12** —— Windows sandbox 真实但**只写**，`enforcement: 'partial'`；该接缝的类型中没有读或出网杠杆。
- **G-SEAM-17** —— `dsh-tool-terminal`（六个 `terminal_*` 工具）**没有任何**出厂 preset 挂载。
- **G-SEAM-43** —— 两个不同的 `epoch` 字段被粗心阅读混为一谈：KERNEL epoch 在内核死亡时推进且可达，而 RUN-RECORD epoch **即便在真实 SIGKILL 与重新接管之后也不推进**。

---

## 6. 本机无法建立的东西

治理约束，引自 `compatibility.lock.json` → `runtime_authorization`：

```json
{ "scope": "LOCAL_IMPLEMENTATION_ONLY",
  "live_provider_budget_authorized": false,
  "budget_amount": null, "currency": null, "deadline": null,
  "restart_resume_authorized": false,
  "external_publication_authorized": false }
```

- **无付费模型评测。无真实 30 子进程 provider 运行。无 vendor benchmark。**
- **实测到的最大真实 N 是 10，在脚本适配器上。** 30 上限边界是用 **29 个算术预留 + 1 次真实调用**触到的；项目自己的容量文件警告：读者"不得从该文件读出'30 个真实子进程被拒绝'"。
- `CAP-08` 是**唯一**文本点名 30 的权威案例。`UPG-07` 是**唯一**文本要求本项不持有授权的案例。
- 白名单机制（`release-gate.py:92`）是一份**带条件的理由**清单，每次运行都对照锁重新求值，而不是裸案例 id。写入者 c12 用非变异探针核实：未列入的 `BLOCKED_EXTERNAL` 案例会让检查 8 失败；而在临时锁中把 `live_provider_budget_authorized` 翻为 `true`，会让 `IPY-08` 条目**自行停止适用**。

**这不是短板 —— 这是设计。** `UPG-08`（"日用最终判决"）要求的正是这个：`NOT_READY`，并报告具体复现与外部阻塞。

---

## 7. 环境与可复现性

| 项 | 值 |
|---|---|
| HEAD | `f019f67aa4b691151aa90036ef7e129eb929e48c` |
| 分支 | `cand-round3` |
| commits / files | 607 / 1984 |
| remote | `refs/heads/master` == 同一 SHA，由独立 `git ls-remote` 验证 |
| 推送类型 | **fast-forward**，非 force-push |
| 固定检出点 | `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`，`git status --porcelain` **为空** |
| 工具链 | Node v24.18.0，Python 3.14.3，TypeScript 6.0.3（取自固定检出点的 `node_modules`） |
| 包 | `dsh-daily-work` 41 生产 + 61 测试 `.ts`；`dsh-ipython` 28 生产 + 21 测试 `.ts`，2 个 `.py` |

**审计方必须知道的两个可复现性陷阱：**

1. **`npx tsc` 在本机是一个诱饵桩。** 它打印 "This is not the tsc command you are looking for"。真正的编译器是 `D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc`，由 `helpers/typecheck.mjs` 解析。
2. **测试必须从包目录运行，不能从仓库根运行。** 测试以 `cwd: process.cwd()` 派生 child 进程，以便通过包的 `node_modules` 解析 `tsx`。**从仓库根运行时 `tsx` 解析不到，每个 child 都以 `ERR_MODULE_NOT_FOUND` 死掉。** 这个缺陷**是我的** —— 它让四个 `durability-advanced` 测试看起来坏了，而从正确目录运行时是 **33/33**。

权威 typecheck：`node helpers/typecheck.mjs` → `typecheck: PASS -- 2 package(s), complete production graph, tests included`，且 `0 non-test cast(s); baseline allows 0`。解析出的程序覆盖 `dsh-daily-work` 的 102 个文件（41 生产 + 61 测试）与 `dsh-ipython` 的 49 个（28 + 21）。

### 7.3 测试套件结果（在已发布提交上实测）

`dsh-ipython`，从包目录运行，`--no-file-parallelism`：

```
Test Files  2 failed | 19 passed (21)
     Tests  2 failed | 206 passed (208)
```

**两个失败是同一个缺陷，且两者单独运行都通过：**

| 测试 | 耗时 | 说明 |
|---|---|---|
| "the record carries the kernel EPOCH, and a restart cannot deliver across generations" | 70524 ms | 撞上 60 秒 `wait_for_ready` 预算 |
| "the straddling write is undecidable, and ordinary in-cell output still works" | 68138 ms | 同上 |

两者都是 §10.1c 的**间歇性 `restart()` 缺陷**。68–70 秒这些数字是**测试自己 60 秒预算加拆卸**，不是对工作量的测量：child 从未就绪。**这是本节最重要的一个数字** —— **把"2 failed"读作两个独立产品失败的审计方是错的，而把"206 passed"读作"IPython 面完全健全"的审计方同样是错的**，因为 restart 路径正是长会话所依赖的路径。

`dsh-daily-work` 未为本文跑完；其较早的完整运行（在 c11 的 cwd 修复之前）已被取代，不应引用。审计方若要其当前数字，应从 `packages/dsh-daily-work` 运行 —— 此前失败的 `durability-advanced` 文件现在 **33/33**。

---

## 8. 发布卫生

- **树内 loopback 会话令牌：零残留。** 用项目自己的模式（`run-a12.mjs:106`：`text.replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>')`）**红删 63 处，跨 61 个文件**。被红删的文件**没有一个**被规格证据引用，所以没有任何记录的摘要被移动；所有 JSON 产物仍可解析。
- **三个仅存在于历史中的令牌 blob 仍可从已发布历史到达。** 重写它们会改变所有下游 commit SHA，并使身份与每一个已归档判决失效，而代价是为了一些在读者能触及的任何机器上都不授权任何东西的令牌。**记录为不值得的取舍，而非疏漏。**
- **已发布 diff 中无凭证形态内容。** 唯一的 grep 命中是 `.github/workflows/post-integration.yml` 内的一个**密钥检测模式** —— 这正是书写凭证相关内容的**正确**方式。
- **`.github/workflows/post-integration.yml` 从未执行过。** 无 runner，无网络授权去添加一个。它是**未经验证的 YAML** —— 一个关于 CI 会做什么的主张，而不是 CI 做了的证据。它自己的文件头也这么写。
- `paid-live-provider.yml` **仅**在 `workflow_dispatch` 时触发，且除非设定了授权变量**并且**锁同意，否则拒绝。它不声明任何 secret，不回显任何 key。

---

## 9. 审计方**不应**接受本报告中的哪些论断

列出这些是为了让审计可以攻击它们：

1. **"104 PASS"** 是关于 **109 案例 trusted-local 规格**的陈述，不是关于 112 案例权威规格的。**而且 104 个里只有 3 个在当前身份上** —— 实测：T2 有 3 个在current、51 个不在；T0、T1、T3、T4 **零个**在current。所以诚实的读法是"104 个判决，其中 3 个绑定在门当前比较的身份上"。§2.1 解释了为何我没有重盖其余 101 个。
2. **"112 中 76 COVERED"** 意味着某产物建立了每个 oracle。它**不**意味着产品已合格，而且其中很大部分是在 provider 边界处用受控适配器测的（§2.5）。
3. **"上限在生产中具有约束力"** 是用 **29 个算术预留 + 1 次真实调用**测的，不是 30 个真实子进程。
4. **"ID-01 PASS"** 依赖合格树正确，加上错树诊断。**主检出点仍带该缺陷**；`dsh-native-daily` 没有被修。
5. **"G-SEAM-19 在产品中已关闭"** 覆盖的是经 `agent/created` 守卫的**进程内** one-shot 子进程。**DSH 自己的池仍是按 root 的。**
6. **315 个 verify-spec 问题未解决。** 我选择不重盖章。若审计方认为重盖章是对的，应当明确说出来，因为它会改变那些条目每一条所断言的内容。
7. **四个 FAIL 中有三个在当前规格文本下永远不会通过。** 若审计的判据是"零 FAIL"，正确回应是**刻意修订规格** —— 那会让当前身份下每一个判决失效 —— 而不是重测。

---

## 10. 本轮我搞错的，记录在案

- **我先标 IPY-13 PASS，后反转** —— 写入者 c7 的独立分类探针显示门只断言了较弱性质。**那道门是一个比其场景更弱的 oracle。**
- **我的串行套件有 cwd 缺陷**，让四个产品测试看起来坏了（§7.2）。写入者 c11 独立发现同一根因，并在全部五个 spawn 点正确修复。
- **我的第一个 IPY-15 修复接了 pump、漏了 reply 路径。** 写入者 c1 发现；我在 `82ac3ee` 关闭该缺口，c1 随后走得更远 —— 见 §10.1c。
- **我最初把 315 个 verify-spec 问题读成阻断项。** 它们按设计仅报告、不追加 blocker；我在源码中核实，而非从 FAIL 标记推断。
- **一个子 agent 报告在 `wt-c1` 与"第二个写入者"冲突。** 那是我 —— 原 agent 死后我完成了那个切片。我做了更正，并把该 agent 重定向到它自己发现的两个真实缺口。
- **我在 §9 的草稿中断言"99 个 PASS 在当前身份上"。** 实测：**3 个**。发布前已更正。

### 10.1 三项审计方应视为实质性内容的更正

**（a）一条既有 GAPS 条目的核心推论无效，其反证方法也不可靠。** 写入者 c11 检视 `G-SEAM-39`（`IPY-06` 抖动）后发现：

- 其核心推论把**空的** `kernel.err` 读作"替换内核从未启动"。但**空 `kernel.err` 是成功启动的正常状态**（实测 0 字节），而在失败试验中 `dsh_attribution_bootstrap.loaded` 标记**是存在的** —— 替换内核**确实启动了**。该推论应被撤回。
- 其反证方法只用了**两次试验**。该案例的基线失败率在**完全相同的代码**上是 **1/8 到 5/8**，所以两次试验什么都证明不了。c11 在自己身上演示了这个错误：它第一次 `newports` 结果读作 5/6 对 3/6，而一次 **8 次试验**的运行把它反转了（5/8 对 7/8 基线）。后续工作**每臂需 ≥20 次试验**。

**（b）`dep-gates` DEP-02 的失败是环境假象，而正确诊断**不是**"被删除"。** 写入者 c11 报告外部审计包"在会话中途从 `Downloads/` 被删除"。**该结论是错的，我通过直接核查更正了它：该包*移动*到了 `C:\Users\hzq00\Downloads\dsh\DSH_NATIVE_IPYTHON_ARCHITECTURE_AUDIT_2026-09-20\`**，其 `delivery/acceptance-spec.json` 仍哈希为 `2fe95835425eb98eb3bac9ee…` —— 与仓库副本逐字节相同。所以测试的对象存在；是**测试硬编码了旧路径**。该失败是**测试中的陈旧路径**，不是溯源失败，诚实的修法是定位该包，而不是弱化断言。c11 选择让它如实失败而不放松断言是对的，判断它不属于其被指派的八个失败也是对的。

**（c）c11 对 IPY-06 的归因成立，是一个**真实的**产品缺陷**，已报告未修：`packages/dsh-ipython/src/broker.py` 中 `restart()` 内的 `self._kc.wait_for_ready(timeout=60)`。决定性观察是：**裸臂（start → restart，无 cell、无 status）失败，而 IPY-06 的确切序列 5/5 通过** —— 所以注入不是那个变量。五种假设被检验并推翻，包括 `newports=True`（5/8 对 7/8 基线 —— 更差）。**决定 restart 成败的变量仍未确定**；价值最高的下一步是加一行 broker 日志，指名替换内核的 pid 与绑定端口。

**对本报告测试证据的后果：** 撰写时套件输出中的两行 `×` —— "the record carries the kernel EPOCH…"（70524 ms）与 "the straddling write is undecidable…"（68138 ms）—— **都是同一个 IPY-06/restart 缺陷在 60 秒 `wait_for_ready` 预算上的显现**，不是独立失败。两者单独运行都通过。**这是一个真实的、可复现的、*间歇性*的产品缺陷，也是仓库中最强的开放技术项。**

---

## 11. 最小后续步骤，按价值排序

1. **IPY-06 / restart 缺陷（§10.1c）** —— `broker.py` 中 `restart()` 内的 `wait_for_ready(timeout=60)`。它**间歇**（同样代码上 1/8 到 5/8），单独跑能过，而且是**最强的开放技术项**，因为 `ipython` 是模型**唯一**的执行面。先加那行 broker 日志（替换内核的 pid 与绑定端口），让下次失败可从日志归因而不是靠排除法，然后**每臂跑 ≥20 次试验**。
2. **G-SEAM-44 / 可达性** —— `dsh-daily-work` 中 8 个不可达非测试模块，其中 `kernel-lifecycle.ts` 让三个 PASS 的 RECOVERY 案例变成关于机制的陈述。把 import-graph 扫描作为常设门来跑很便宜，不需要预算。
3. **G-SEAM-19 / host 级容量** —— 权威规格的 `CAP-01` 要求"任何时刻不超过 30"。台账是 host 级的；DSH 的池不是。**这是核心容量主张。**
4. **G-SEAM-18 / 深度天花板** —— `maxDepth: 99` 抬高上限，且省略值在 workflow/PTC 路径上等同 99。
5. **裁定 `CMP-04` 与 `IPY-13`** —— 两者都需要刻意的规格修订，那会让当前身份下的判决失效。**这是交付所有者的决定，不是一次测量。**
6. **裁定身份制度** —— 在门中采用 V5 §14 契约身份，或记录为何保留已取代的那套。该决定一旦做出、并按所选制度重测证据，315 个问题即刻清零。
7. **修两处陈旧记录** —— `compatibility.lock.json` → `promotion.decision_reason` 指名了已取代的身份并把 `spec_path` 与错误的摘要配对（§2.1）；`dep-gates` DEP-02 硬编码了审计包的旧路径（§10.1b）。
8. **`SEC-01`/`SEC-03`** —— 要么供给 Linux 执行世界，要么把它们记为 non-claim，正如 v1 规格已对五个权威案例所做的那样（它把它们标为 `NOT_APPLICABLE`，而权威规格**根本不提供**该状态）。

---

## 12. 一句话结论

**本仓库的工程纪律是真实的：缺陷被发现、被测量、被记录、被区分"产品缺陷"与"记录缺陷"，并且在证据不支持时拒绝把判决翻绿。** 但**产品尚未合格**：`NOT_READY`，一个阻断项，四个强制案例失败，其中最值得注意的开放技术缺陷是一个间歇性的内核重启失败 —— 而 `ipython` 是模型唯一的执行手段。**最诚实的读法既不是"做完了"，也不是"没做"：是"机制基本齐备且大部分经实测，但强制要求中至少有一条（30 并发 host 级约束、以及重启可靠性）尚未达到可用标准"。**
