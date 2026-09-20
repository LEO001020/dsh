# 审计请求：DSH trusted-local 验收结果与后续路径

> **提交对象：GPT Pro 模型**
> **请求：审计本次验收执行及其13个FAIL，判定哪些必须修、哪些可以接受，并给出优先级与修法。**
> **本文所有数字均为本机实测，非推断。每个断言标注证据路径。**
> **本文不含任何凭证。**

---

## 第一部分：本地现状（已实测）

### 1.1 部署身份

| 项 | 值 |
|---|---|
| upstream | `deepseek-ai/deepseek-harness` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`（`dsh-v0.1.6-alpha.2`） |
| 本地 checkout | `D:\DSH\src\dsh-src`（钉住） |
| 实现仓库 | `D:\DSH\work\dsh-native-daily`，branch `ipython-native` |
| 构建后的 launcher | `node apps/cli/lib/bin.js`，sha256 `69c49c871735dc7ee81ec51f266bbec129f075fd5066e046374f4b13ab02a705` |
| 部署身份 | `0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461` |
| 晋级决定 | `NOT_READY` |
| 平台 | Windows 11 (10.0.26200) AMD64，Node v24.18.0，pnpm 11.7.0，Python 3.14.3 |

**身份的含义**：`deployment.identity` 是对 `deployment.inputs` 的 sha256。任何一项变化都会改变身份并作废记录在旧身份下的全部 PASS。这是刻意设计。本次执行中身份被重新派生过一次，因为**三个输入已陈旧**（见 §2.4）。

### 1.2 架构（本次目标）

trusted-local：**OS 用户账户即执行权限边界**。DSH 以调用者身份运行，无沙盒、无 WSL、无 Linux VM、无 SSH 执行世界。IPython 内核是模型的主执行面，且是**唯一**执行面（`pwsh`/`bash` 均不在 daily preset 中）。

架构的完整声明在 `docs/decisions/TRUSTED-LOCAL-SPEC.md` 与 `compatibility.lock.json` 的 `deployment.trust_model_statement`。

### 1.3 验收规格执行结果

规格：`qualification/specs/acceptance-spec.trusted-local-v1.json`（109 case，11 family，全部 mandatory）。

| 状态 | 数量 |
|---|---|
| PASS | 95 |
| FAIL | 13 |
| BLOCKED_EXTERNAL | 1 |
| **NOT_RUN** | **0** |

分家族：

| Family | Cases | 结果 |
|---|---|---|
| VERIFICATION | 9 | 9 PASS |
| COMPOSITION | 14 | 12 PASS, 2 FAIL |
| CONCURRENCY | 13 | 12 PASS, 1 FAIL |
| DATA | 12 | 10 PASS, 2 FAIL |
| RECOVERY | 10 | 8 PASS, 2 FAIL |
| IDENTITY | 6 | 3 PASS, 3 FAIL |
| IPYTHON | 15 | 12 PASS, 2 FAIL, 1 BLOCKED |
| NATIVE BRIDGE | 12 | 11 PASS, 1 FAIL（`BR-07`，见 F13） |
| RESEARCH | 6 | 6 PASS |
| CACHE/OBSERVABILITY | 6 | 6 PASS |
| FILESYSTEM | 6 | 6 PASS |

### 1.4 四个独立校验器（全绿）

| 校验器 | 命令 | 结果 |
|---|---|---|
| 规格/证据一致性 | `python qualification/runners/verify-spec.py` | exit 0：每条证据文件存在、记录 sha256 与磁盘匹配、路径在 `qualification/results/` 下、状态与产物一致 |
| 部署身份 | `python qualification/results/T1-spec/verify-identity.py` | **30/30** |
| 元数据输入 | `python helpers/doctor.py` | exit 0 |
| 类型检查 | `tsc -p tsconfig.check.json --noEmit` | exit 0 |

**这四个都不判定"oracle 是否被满足"**——那是阅读证据的人的判断，每个 slice 的 `GATES.md` 是判断发生的地方。脚本只检查机械属性（存在性、哈希、身份、状态/产物一致），这正是赶时间写结论时会被跳过的那部分。

---

## 第二部分：13 个 FAIL 的完整清单

**每个 FAIL 都是一个带实测机制的发现，不是工作缺口。** 按我判定的严重度排序。

### 2.1 阻断日用（3 个，F1–F3）

这三个是同一形状：**机制正确，产品里没有调用者。**

#### F1. `G-SEAM-31` — 没有任何用户动作能创建 run

| 项 | 内容 |
|---|---|
| 规格 case | `CAP-10`（及 `C1` 依赖） |
| 实测 | `WorkService.createRun` 在**全仓库只有 1 个非测试调用者**：`durability-runner.ts:63`，一个手工运行的 CLI，它自己也不在任何生产 import 图中 |
| 后果 | 模型面向的 `work` 工具先解析 run，找不到就抛 `this session has no active run; a run is created by user authorization`（`tools.ts:132`） |
| 影响 | **强制的** N=10 rolling child top-up 在组装后的 profile 上**无法被任何用户动作触发**。所有 N=10 测量都来自直接调用 `createRun` 的测试 |
| 已排除 | 已用**阳性对照**证明遍历与服务本身工作正常：通过真实 API 创建 run 后，工具的同一查找逻辑能找到它（`qualification/results/ROOT-verification/work-tool.json`） |
| 已排除的候选 | `session/created` 钩子（"每 session 一个 run"不等于用户授权）；`settings` section（action 不是配置值，会每次启动重建 run）。均记录在 `docs/GAPS.md` G-SEAM-31 |
| 已确认在生产的 | 硬上限 30 **是**在生产中生效的：真实的 `startContinuable` 调用在 30 被拒，拒绝消息点名部署常量（`qualification/results/T10-capacity/prod-capacity-report.json`） |

#### F2. `G-SEAM-34` — Python cell 无法触达任何 DSH 工具

| 项 | 内容 |
|---|---|
| 规格 case | 12 个 BR case 中 11 PASS、1 FAIL（`BR-07`，见 F13）。**所有 BR case 都是机制结果**——它们问的是"bridge 行为是否正确"，答案是正确。G-SEAM-34 是关于**组合**的事实，不是任何单个 BR oracle 的失败 |
| 实测 | `bridge.ts` 与 `native-call.ts` **在每个 package 入口点的传递闭包之外**；`new BridgeServer` **零生产调用点**。两个独立仪器一致：T7 的符号级探针 + `qualification/runners/import-graph.mjs` 的编译器级闭包 |
| 后果 | **被禁止的** seam 正确地不存在（`ctx.terminalController` 在所有生产文件中零出现，T7 用三种方法测过）——但**被许可的**那条未接线。所以模型的 Python 今天**两条路都无法触达工具** |
| 为何更严重 | `ipython` 是模型**唯一**的执行面（27 工具，`pwsh`/`bash` 缺失）。这不是学术问题 |
| 机制本身 | 正确且已测：真实 cell 的 `dsh.call` 到达 `ctx.tools.execute`（从注册表侧观测）；3 次调用产生恰好 3 次 dispatch（**一个** model loop）；6 个 native-call arm 全部有结构化结果 |
| 顺带修好的真实缺陷 | async 路径泄漏裸 `TimeoutError`（无 `.code`），而 `call_sync` 对同一条件抛 `BridgeError("TIMEOUT")`——一个 `except BridgeError` 的程序在一条路上崩溃、在另一条上正常。已在 `bridge.ts` 修复 |

#### F3. `G-SEAM-33` — 策略模式声明 `workspace-write`，与架构矛盾

| 项 | 内容 |
|---|---|
| 规格 case | `CMP-02`（FAIL） |
| 实测 | `sandboxPolicy.defaultMode === 'workspace-write'`，`policy.resolve({})` 返回 `{mode:'workspace-write', workspaceRoot:'C:\Windows\Temp'}`。两个独立仪器一致 |
| 根因 | profile 里**没有** `sandbox-policy` row，所以上游 base bundle 的 `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`（`bundle/base/cordis.patch.yml:218`）生效，而该环境变量未设。本项目**改过**紧邻的另一个表达式（`policy: … ? 'never' : 'ask'`，`:234`）并在 patch 里长篇论证，**但没改 `mode`** |
| 后果 1 | 策略向模型注入一行它读作关于自身权限的**事实**的系统提示：`Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: <root>`（`sandbox-policy/src/index.ts:46-47`）。在本架构下这是**假的**——没有文件沙盒，也没有 workspace 限制。且它点名的 root 依赖进程 cwd |
| 后果 2 | `ptc-runtime-node` 在 mode **不等于** `danger-full-access` 时仍做 confine：`confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(...)`（`ptc-runtime-node/src/index.ts:224`）。PTC 是唯一仍在围栏内的路径，而它**可达**（`workflow`/PTC 工具族在组装后的 catalog 中） |
| 已挂载的检测器 | 新接线的 `daily-no-sandbox-contract` 守卫每次启动跑 8 项部署检查，其**两个失败正是这两点** |

### 2.2 真实缺陷，不阻断日用（10 个，F4–F13）

#### F4. `G-SEAM-47` — 一个**已编译**文件 import 上游 `src/*.ts` 路径

| 项 | 内容 |
|---|---|
| 规格 case | `ID-01`（FAIL） |
| 实测 | `packages/dsh-daily-work/lib/artifacts.js:73`——**构建产物**——包含 `import { publishImmutableObjectStream } from '@deepseek-ai/dsh-attachment-local/src/store.ts'` |
| 上游为何允许 | 该包 `exports` 同时提供 `"."` → `./lib/index.js` **和** `"./src/*"` → `"./src/*"`，所以逃生舱是刻意提供的 |
| 后果 | 包的入口**内联**了自己的那份模块，于是 host 持有**两个实例**，模块级 `durableHomes` 被**分裂**。已用 `ts.transpileModule` 验证两份是**同一 revision**——所以是重复工作 + 状态分裂，不是行为分歧（这是好消息，不改变结论） |
| 为何 oracle 的无条件措辞是对的 | 这正是"第二份物理副本"出现的机制，而本项目已为此付过代价一次：`TOOL_RUNTIME_SCHEDULER` 是 `Symbol(...)` 而非 `Symbol.for(...)`，两份 core tools 不共享注册表键——正是它杀死了 source launcher 而 built launcher 正常 |
| 修法方向 | 上游存在 built 公共路径，只是没导出该符号。所以是**上游加一个 export**，不是本项目重写 |

#### F5. `G-SEAM-45` — 并发 drain 超发，而 deficit 读数仍为 0

| 项 | 内容 |
|---|---|
| 规格 case | `CAP-10`（FAIL） |
| 机制（引自 `host.ts:1242-1256`） | `const inFlight = this.pendingDrain.get(runId); if (inFlight !== undefined) await inFlight; const task = this.runDrain(runId, requests, signal); this.pendingDrain.set(runId, task)`。K 个并发调用者 await **同一个** in-flight drain，它 settle 时它们在同一 microtask 批次恢复，各自启动**自己的** `runDrain`。target/deficit 检查（`mayAdmit`）在 `runDrain` **内部**，读的是它们都还没写入的记录，所以 K 个都看到同一 deficit，K 个都 admit |
| **注释与代码矛盾，值得单独指出** | `await inFlight` 上方的注释写："Coalesce: a drain is already running for this run. **Absorb rather than stacking a second concurrent drain that would race on the same slots.**" 但代码**确实**堆叠了第二个：`await inFlight` 之后它**无条件**启动自己的 `runDrain`。注释描述的是意图，代码做的是相反的事——而 `await` 恰好是制造竞态的机制（所有等待者在同一 microtask 批次恢复）。**这正是本项目反复记录的形状，只是方向相反**：通常是一个机制正确而无人调用；这里是一个机制**被调用且注释声称它做了防护**，而防护没有实现。审计者若只读注释会认为这个洞已被堵上 |
| 实测数字 | `freedSlots=2 concurrentRequests=3 admitted=3 heldAgainstTarget3=4 deficitAfter=0`。目标 3，四个 task 持有 slot，**`capacityDeficit` 读 0** |
| 为何是强发现 | **用零个真实 child 测出来的**（直接驱动算术）——这很重要，因为这个家族里"spawn 30 个看看"会是昂贵的错误直觉。而**不可见性是更尖锐的一半**：部署**有**一个专门报告 deficit 的读者，而这个缺陷恰恰是它报告健康的 0 而目标已被超过 |
| 对比 | **budget** 检查在单条记录 `update` 内部，所以 `CAP-09` 通过；**target** 检查在它外面，所以 `CAP-10` 失败 |
| 修法方向 | drain 路径的并发控制改动（await 后重新检查，或队列而非合并 promise）。是设计决定，带自己的门 |

#### F6. `G-SEAM-41` — page cursor 跨 revision 被拒，跨 store 不被拒

| 项 | 内容 |
|---|---|
| 规格 case | `DATA-11`（FAIL） |
| 实测 | 跨 revision 被拒（`pagination-scope-denied`）；跨 store——oracle 点名的第一个向量——**未被拒，产出了 64 字节** |
| 危害（已隔离） | `pages()` **直接**调用 `store.openRange`，从不经过 `resolveReference` 的内容检查。所以另一个持有不同字节、但内容地址相同的 store，被服务为哈希 `cc7321cc…` 的字节，而 descriptor 写的是 `9076e7f7…` |
| 结构原因 | `PageCursor` 与 `cursorSecretOf` 不携带 store identity，所以即使读路径做了检查，cursor 自身的数据也无法拒绝外来 store |
| 同类 | 检查**存在**，而**重要的那条路径不调用它**——正确且不在路线上的机制 |

#### F7. `G-SEAM-40` — 六个 gap 阶段里两个没有生产者，两个平面不相交

| 项 | 内容 |
|---|---|
| 规格 case | `DATA-09`（FAIL） |
| 实测 | 封闭集是真实的并被强制（`observations.ts:60-75`，zod enum `:226`），verdict mapper 处理全部六个（`coverageVerdictOf`，`:182-188`）。**四个阶段有真实生产者并已驱动**：`native-acquisition`（`artifacts.ts:1097`）、`retention`（`:1050` quota，`:1154` orphan window）、`provider-acquisition`（`web-provenance.ts:203`）、`transform`（`:348` throw，`:364` empty）。**两个没有**：`transport` 与 `model-projection` 只出现在封闭集、类型 union、verdict mapper 和一个测试 fixture 中——生产源码里 **0 个赋值** |
| 更尖锐的一半 | transport 丢失**确实**在 IPython 平面被计数（`droppedFrames`，而 `OutputBuffer.note_dropped_frame`（`broker.py:139`）**零调用点**，见 F12），但那个计数**从未接进** `acquisition.gaps`。**两个平面不相交**——这就是为什么该阶段存在于词表中却没有生产者：有人命名了这个丢失，而没有任何东西把测量它的地方和报告它的地方连起来 |

#### F8. `G-SEAM-21` / `REC-09` + `REC-10` — epoch 守卫不可达

> **本行的实测事实保留为历史记录，未改写。** 该 F8 的**处置已改变**：不是接线，而是**删除**（commit `6bfc810`，由 `00421ec` 修正）。
> `applyWorkerSettlement`、其 `WorkerSettlement` 类型、其 `RefusalLedger` 与 `dsh_daily_work_refusals` 域、以及 run record 的 `epoch` 字段**全部被删除**，因为拓扑测量表明该守卫的**输入在任何生产路径上都无法构造**（不只是不可达）：没有任何生产调用点会写入终态，而产品实际留下的未决状态 `unknown`（保留 reservation）没有任何生产出口。
> 因此 v1 的 `REC-09`/`REC-10` **保持 FAIL**，v2 记录为 **NON-CLAIM** 而非修复。
> 证据：`qualification/results/R9-recovery-topology/`（`TOPOLOGY.md`、`TEST-LEDGER.md`、`CONTROL-FALSIFICATION.txt`、`unknown-exit-probe.txt`）。
> 下表"未修的原因"一行所述的"没有生产 settlement 入口可接"正是删除的依据，而非接线的理由。

| 项 | 内容 |
|---|---|
| 规格 case | `REC-09` FAIL、`REC-10` FAIL |
| 实测 | `recovery.ts` **无任何非测试 importer**，且不在任何 package 入口点的传递闭包内（两个独立仪器一致）。`applyWorkerSettlement` 在自身模块与其测试之外无调用者。`epoch` 字段在 `initialRunRecord` 设为 1 之后**无人 bump、无人读** |
| 在可达路径上也不可表达 | `WorkService.transition` **不接收 epoch 参数**，所以一个陈旧 epoch 的 settlement 交给它会被**静默忽略**（实测：transition 生效、reservation 释放、tombstone 写入、epoch 从未被查） |
| `REC-09` 的 oracle 决定了它是 FAIL | oracle 写"来自被取代世代的 settlement **落地**即 NOT PASS"。而实测正是它会落地 |
| 未修的原因 | 没有生产 settlement 入口可接；接线等于**发明一个调用者** |
| **处置（后续）** | **删除，不接线** —— 守卫、类型、refusal ledger、独立域与 `epoch` 字段全部移除；v1 的两个 FAIL 保留为历史。`docs/DELETE-AUDIT.md` §3.8.1 已更新为 CLOSED BY DELETION |

#### F9. `G-SEAM-46` — 规格**自相矛盾**

| 项 | 内容 |
|---|---|
| 规格 case | `CMP-04`（FAIL）vs `CMP-13`（PASS） |
| 矛盾 | `CMP-04` 要求 "`toolCountAgentKey` is 28, `ipython` is present, **`pwsh` is present**"；`CMP-13` 要求 "`pwsh` … **must be ABSENT** from the daily catalog … A catalog that still contains `pwsh` is NOT PASS" |
| 同一个测量 | 目录是 **27 工具、`pwsh` 缺失**，所以 `CMP-13` PASS、`CMP-04` FAIL |
| 时间线（git） | 规格撰写于 `2026-09-20 04:59:30`（`f6ac93c`）；`tool-pwsh` 在 `05:18:50`（`35c829d`）被无条件禁用——**19 分钟后**。规格的 `trusted_local_acceptance_spec_sha256 = e5b6a1d2…` 冻结在更早状态 |
| 这个 FAIL 是关于规格而非产品 | `CMP-04` 的另外三个子句全部成立（实测 `ipythonToolPresent: true`、`workToolPresent: true`、`error: null`），工具面完整。是 **oracle 的数字**描述了一个被架构决定取代的组合 |
| 为何没有改 oracle | 规格两次禁止（"no PASS by editing an oracle after the fact"；"a case may only be marked PASS when that file establishes THIS oracle"），且改动会**抹掉规格与部署已经分叉这个记录** |

#### F10. `G-SEAM-48` — `tsconfig.json` 漏掉 `tsconfig.check.json` 能抓的类型错误

| 项 | 内容 |
|---|---|
| 规格 case | `ID-05`（FAIL） |
| **对照臂才是发现** | 注入一个类型错误后：`tsconfig.check.json` 在注入行 exit 2；**对照臂 `tsconfig.json` exit 0，漏掉了它** |
| 后果 | 两个配置**不可互换**，而读者或 CI 若伸手去拿更显眼的 `tsconfig.json`，会在一棵不过类型检查的树上拿到绿色 |
| 树本身 | 干净（两个 package 均 exit 0），所以这不是"树坏了"的断言，而是"两个检查器之一看不见它如果坏了" |
| 相关 | 逃生舱扫描：`as any` 0 个真实，`@ts-ignore` 0 个，但 `as never` 很多——集中在测试文件与 `durability-runner.ts`（手工 CLI，非产品代码） |

#### F11. `G-SEAM-49` — 钉住的 checkout 树不干净

| 项 | 内容 |
|---|---|
| 规格 case | `ID-06`（FAIL） |
| 实测 | HEAD **匹配** `ddefc45fbc7f8e46dd73185e68295696d1297887`；树脏：` M packages/deliverables/workspace-changes/src/index.ts`、`?? DSHhomem914/`、`?? data-artifacts/` |
| 为何仍记录 | checkout 文档标注为 disposable，且本项目的门自己往里写东西，所以脏在某种意义上是预期的。但**该 case 真正测的是**：读者能否把"被认证的 artifact"和"被改动的 artifact"区分开，而诚实答案是 checkout 的 git 状态**单独无法**做到——HEAD 被钉住且正确，而工作树同时带着一个被修改的 tracked 文件和两个未跟踪目录 |
| 更强的仪器已存在 | 部署身份覆盖 `artifact_sha256`，所以 launcher 的摘要是能在脏 checkout 下存活的检查，`helpers/doctor.py` 验证它。该 case 的"树干净"子句因此是**较弱**的仪器 |

#### F12. `IPY-13` + `IPY-15` — 两个 IPython 平面缺陷

**`IPY-13` clause 2 FAIL — 静默错误归属。** 规格要求"在后续 cell **期间**落地的写入被报告为 undecidable 而非被归属"。实测：**被归属**。`lateCount 0`，标记出现在 cell 三的 stdout 里、位于 `tick1` 与 `tick2` 之间。机制（平台而非 broker）：`ipykernel/iostream.py` 从 `contextvars.ContextVar` 解析 stream parent，带**全局** fallback；`threading.Thread` 以空 context 启动，所以写者取全局值——最近一次设置它的 cell，也就是**更晚的**那个 cell。broker 的 router 在它掌握的信息上是正确的。clause 1（返回后的写入是 late 且不搭载任何东西）成立。

**`IPY-15` FAIL — 超限帧的计数没有生产者。** `OutputBuffer.note_dropped_frame`（`broker.py:139`）——`droppedFrames` 的唯一写入者——**零调用点**，所以 `ipython-tool.ts:69` 的 renderer 分支是死代码。超限帧在**两个方向都被拒**（编码抛错、解码在缓冲前按声明长度拒绝），所以那一层没有静默丢失字节；缺的是**计数**。

#### F13. `G-SEAM-54` — bridge 路由**没有 disposition 词汇**

| 项 | 内容 |
|---|---|
| 规格 case | `BR-07`（FAIL） |
| oracle | "Every in-flight call carries one disposition from `settled`, `cancelled`, `handed-to-jobs`, `abandoned-unstarted`，且任何交给 Jobs 的 call 要点名它的 job id。**Nothing continues silently in the background with no record.**" |
| 实测（grep） | `disposition`、`jobId`、`handoff` 在 `packages/dsh-ipython/src/bridge.ts` 与 `native-call.ts` 中出现 **0 次**；在 `packages/dsh-daily-work/src/programmatic-scope.ts` 中出现 **21 次** |
| 成立的那一半 | bridge 的 drain **确实**会等：一次 `revoke` 为在途 call 等了 **1499 ms**，revoke 之后的 call 被拒 `LEASE_REVOKED`。所以 lease 纪律是真的，drain 是真的——**缺的是记录** |
| 为何"缺记录"是发现而非细节 | oracle 自己的那句话点名了失败模式："nothing continues silently in the background with no record"。drain 等 1499 ms 恰恰就是"一个 call 在后台继续而没有任何东西写它变成了什么"。读者无法从 bridge 判断那个在途 call 是 settled、cancelled 还是 abandoned |
| 词汇可实现 | scope 路由就是证据——同一个仓库、同一个工具注册表，21 处引用之遥 |

### 2.3 BLOCKED_EXTERNAL（1 个）

`IPY-08`（a natural activation end rebinds or reports loss explicitly）——阻塞在**授权**而非代码。

### 2.4 执行期间修好的、否则会让全部工作作废的东西

| # | 问题 | 处理 |
|---|---|---|
| 1 | **部署身份三个输入陈旧**：`host_profile_digest` 钉 `59f23346` 而磁盘是 `5b8b2a8e`（profile patch 多了 258 行未提交的 trusted-local 改动）；`agent_preset_digest` 钉 `0934f22b` 而磁盘是 `16bc20e5`；`agent_preset_id` 写 `standard` 而 roster 默认 `daily-standard` | 重新派生为 `0a0996f3…`，旧值记入 `identity_history`。**其中两个是靠逐个复核每个输入而非只查被报告的那个发现的** |
| 2 | **规格既是身份输入又是证据账本**：第一次归档就打破四个身份检查，其中两个（"no case is pre-marked PASS"、"no case ships with evidence"）在活文件上**根本禁止归档** | 冻结"作者时快照"到 `qualification/specs/frozen/`，其哈希**正好等于**被钉住的 `e5b6a1d2…`。pin 现在保护作者时 artifact；新增两条活账本检查（case id 与冻结快照一致；status 在词表内）。双向验证：带 109 条归档 exit 0；把冻结快照篡改成预标 PASS 则 exit 1 并点名 |
| 3 | **`helpers/doctor.py` 不存在**，尽管两份手册都让操作者去跑它 | 补上。双向验证：干净树 exit 0；篡改一个输入 exit 1 并**同时**点出两个症状（身份不再重算 + 哪个输入陈旧，附两个哈希） |
| 4 | **`verify-spec.py` 不存在**，而十个 agent 正在往规格里归档 | 补上。用四个注入缺陷验证：不存在的证据文件、被禁止的 `NOT_APPLICABLE`、逃出结果根的路径、挂在 `NOT_RUN` 上的证据——全部检出 |
| 5 | **no-sandbox 契约守卫编译了、测试了、从未被挂载** | 加 exports 条目与 patch row。实测：服务存在、8 项检查、`rowPresent: true`，**两个失败正好是 F3** |
| 6 | **我自己撤回两个发现** | `G-SEAM-29`（kernel cwd）与 `G-SEAM-36`（restart）都是 harness 假象——前者跑在陈旧 `lib/` 上，后者用手工构造的 host 绕过了产品自身的目录创建。均已撤回并保留记录 |
| 7 | **我的一个假设被 agent 的实验推翻** | `G-SEAM-39` 的候选原因（介入的 `status()` 留下未决 shell waiter）被单变量实验否定：带介入 1823 ms 通过，不带 11852 ms 通过 |

### 2.5 反复出现的缺陷类（11 个实例）

本次执行的**核心发现**是一个反复出现的形状：**机制被实现、被单元测试、正确——而产品里没有任何东西调用它。**

| # | 未接线的东西 | 后果 | 状态 |
|---|---|---|---|
| 1 | `setLaunchPort` | 组装后的 profile 无法启动任何 child | 已修 |
| 2 | `takeContinuation` | 两个 continuation owner 可能驱动同一个 root | 已修 |
| 3 | `recovery.ts` epoch 守卫 | `epoch` 字段在**跨进程**场景下是惰性的 | **已处置：删除，不接线**（F8）—— 守卫、类型、refusal ledger、独立域与 `epoch` 字段全部移除；v1 的 `REC-09`/`REC-10` 保持 FAIL，v2 记为 NON-CLAIM |
| 4 | `ctx.dailyHistory.history(caller)` | M7 历史平面已挂载并服务授权读，**零生产消费者** | 未修 |
| 5 | `host.ts` 的 user-cancel 重检 | 缺的是 await **之后**的重读 | 部分 |
| 6 | M7 的 inject 回归测试没有守住它 | 从 root context 调用永不抛错 | 已修 |
| 7 | 整个 `packages/dsh-ipython/` **不在 git 里** | 约 250 KB 源码（含模型唯一执行面）只存在于本机 | 已修 |
| 8 | kernel cwd（我误报） | — | **已撤回** |
| 9 | `WorkService.createRun` | 强制的 N=10 无法触发 | 未修（F1） |
| 10 | IPython native bridge | Python cell 无法触达任何工具 | 未修（F2） |
| 11 | `kernel-lifecycle.ts` | REC-06/07/08 的 PASS 是机制而非产品 | 未修 |
| 12 | `CMP-06` 的策略保护 | 保护来自"无调用者"而非 setter 拒绝——host 代码调用 `setPolicy` 确实能改 | 未修 |
| 13 | `note_dropped_frame` | `droppedFrames` 结构性恒为 0 | 未修（F12） |

### 2.6 执行方法（供审计判断证据可信度）

- **10 个 agent 并行**，每家族一个，各自拥有不重叠的 slice 目录与规格 case。
- 每个 agent 收到：该家族的**已测状态**（避免重复推导）、CPU 约束（一次一个测试文件、一次一个 boot、不从盘根搜索、不跑负载循环）、**本项目已产生过假发现的陷阱清单**（陈旧 `lib/`、陈旧 install、固定输出路径、手工构造 harness、空阴性）、以及 `verify-spec.py`。
- **三个机械校验器**防止归档本身出错：`verify-spec.py`（证据存在/哈希/路径/状态一致）、`verify-identity.py`（身份与反作弊对）、`doctor.py`（输入 vs 磁盘）。
- **所有测量都记录它跑在哪个 build 与哪个安装组合上**——因为今天有两个发现因跑在陈旧 artifact 上而被撤回。
- **过程中发生 5 次并行 git 事故**（`reset --hard` 孤立提交、`commit -a` 扫入兄弟文件、`--amend` 竞争、宽泛 `git add` 拉入在制品、一次未提交归档被回退）。全部由发现的 agent 检测并修复，无内容丢失，已记为 `G-SEAM-35`/`G-SEAM-42`。

---

## 第三部分：需求（请审计并给出判定）

### 3.1 我需要你判定的核心问题

**Q1. F1（无 run 创建者）该怎么修？** 我排除了两个候选（`session/created`——"每 session 一个 run"不是用户授权；`settings` section——action 不是配置值，会每次启动重建 run）。剩下的候选是**模型面向的 `work` 工具自身加一个 create action**，理由是它自己的错误文本已经说"a run is created by user authorization"，且它已持有确切的调用 Agent——授权边会落在拒绝被抛出的地方。它的 action enum 目前是 `status | submit | finish`。**这是对的入口吗？还是应该有别的入口（一个 UI 动作、一个明确的用户命令、一个 host 级 API）？** 我拒绝自动调用者（在 session 创建时、首次使用时、服务挂载时），因为那会**伪造**用户授权边。

**Q2. F2（bridge 未接线）该由谁构造 `BridgeServer`？** 机制正确且已测，缺的是一个生产调用点。**正确的 owner 是谁**——kernel plugin 在创建 kernel 时？host plugin？`ipython` 工具在首次调用时？需要什么生命周期约束（它必须比 cell 活得久吗？必须在 kernel 重启后重建吗？）

**Q3. F3（策略模式 `workspace-write`）该怎么处理？** 两个选项我看到的：(a) 在 profile 里显式声明 `danger-full-access`，让声明与架构一致；(b) 保留该模式但删掉那行注入到模型的提示。**哪个对？** 有第三种吗？注意 (a) 会让 PTC 不再 confine（`ptc-runtime-node:224`），这是一个真实的行为变化而非纯声明修正。

**Q4. F9（规格自相矛盾）该怎么收？** 两个诚实选项：(a) 用**新身份**取代规格（会作废记录在 `0a0996f3` 下的全部 95 个 PASS——所以是刻意步骤而非修复）；(b) 接受它作为**永久记录的矛盾**。**哪个对？** 如果选 (a)，是否应该把"任何归档都会改变规格字节"这个结构问题一并解决（例如把 case 定义与 verdict 拆成两个文件）？

**Q5. 另外 7 个 FAIL（F4/F5/F6/F7/F8/F10/F11/F12）的优先级排序与修法。** 我目前的判断是 F5（drain 超发）和 F4（双实例）最该先修，因为它们是**静默的正确性缺陷**（超发对 deficit 读者不可见；模块状态分裂）。F8（epoch 守卫）需要先决定"跨进程 settlement 入口"是否存在。**你同意吗？**

> **该问题已有答案（后续处置）。** "跨进程 settlement 入口"经测量**不存在**，而且不存在得比预想更彻底：没有任何生产调用点会写入终态，产品留下的 `unknown` 也没有生产出口。因此 F8 的处置是**删除**（`6bfc810`、`00421ec`），不是接线。见 `qualification/results/R9-recovery-topology/` 与本文件 F8 行的"处置（后续）"。

**Q6. `CMP-06` 的保护是"不可达"而非"不可变"（§2.5 #12）——这算缺陷吗？** 实测：host 代码调用 `setPolicy` 确实能改。保护来自无调用者。**是否需要一个真正的守卫（拒绝运行时改 mode），还是"无调用者"就是充分的？**

**Q7. 我的执行方法本身有什么问题？** 特别是：并行 10 个 agent 在一个 git 工作树里（产生了 5 次事故）；用"每个 FAIL 都是发现"的框架（会不会让本该修的缺陷被记录成"发现"就算了）；以及我撤回两个发现的做法（是否撤回得过头——`G-SEAM-36` 的 restart 抖动**仍然存在**，只是机制未隔离）。

### 3.2 我明确不做的事

- 不通过改 oracle、跳过 case、降低阈值、扩大权限或假报结果取得 PASS。
- 不自动 push 或发布（仓库无 remote）。
- 不消耗未授权的付费 API 预算（`live_provider_budget_authorized: false`）。
- 不发明调用者来让门变绿。
- 不把"机制正确"当作"产品可达"。

### 3.3 关键证据索引

| 内容 | 路径 |
|---|---|
| 验收规格（权威） | `qualification/specs/acceptance-spec.trusted-local-v1.json` |
| 规格/证据校验器 | `qualification/runners/verify-spec.py` |
| 身份校验器（30 项） | `qualification/results/T1-spec/verify-identity.py` |
| 元数据检查 | `helpers/doctor.py` |
| 全部缺陷（G-SEAM-31…53） | `docs/GAPS.md` |
| 最终状态索引 | `qualification/results/ROOT-verification/STATUS-final.md` |
| 每家族门表 | `qualification/results/V1-identity/GATES.md` … `V10-research-obs/GATES.md` |
| 架构声明 | `docs/decisions/TRUSTED-LOCAL-SPEC.md` |
| 安装/运维/恢复手册 | `docs/DELIVERY.md`、`docs/OPERATIONS.md`、`docs/RECOVERY.md` |
| 删除审计 | `docs/DELETE-AUDIT.md` §5b |
| 缺陷类分析 | `docs/DELETE-AUDIT.md` §3 + `docs/GAPS.md` 末尾 |

---

## 第四部分：一句话总结

**架构已建成（IPython 是模型唯一执行面，27 工具，硬上限 30 在生产中生效），109 个验收 case 全部执行：95 PASS / 13 FAIL / 1 BLOCKED_EXTERNAL / 0 NOT_RUN。**

**晋级仍是 `NOT_READY`，理由不是 FAIL 的数量，而是其中三个 FAIL 是用户实际会撞到的：**没有任何用户动作能创建 run（强制的 N=10 因此不可触发）、Python cell 无法触达任何 DSH 工具（两条路都不通）、策略模式声明 `workspace-write` 与架构矛盾（模型被喂了关于自身权限的假陈述）。

**本文件在执行中自我更正过一次**：`BR-12` 我原本按"可达性"判 FAIL，在 V4 直接测出该 oracle 的否定情形（caller 无法抬高上限）后改为 PASS。原因是"部署不可达"与"机制不正确"是两个不同的断言，用前者回答后者的 oracle 会读出与实测相反的结论。**这类更正本身就是我想请审计者检查的东西——见 Q7。**

**请审计这 13 个 FAIL 的判定、优先级与修法，特别是 Q1–Q3 的入口选择。**
