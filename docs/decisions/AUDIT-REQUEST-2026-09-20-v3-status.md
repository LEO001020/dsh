# DSH TRUSTED-LOCAL 项目 — 审计请求与现状汇报

**日期**: 2026-09-20
**工作树**: `D:\DSH\work\wt-integrate`, 分支 `integrate-test`, tip `85c55e0`
**钉住检出区**: `D:\DSH\src\dsh-src` @ `ddefc45fbc7f8e46dd73185e68295696d1297887`
**规模**: 314 commits / 1570 tracked files / daily-work 54 测试文件 + ipython 12 测试文件
**V3 主提示词**: `C:\Users\hzq00\Downloads\DSH_TRUSTED_LOCAL_MASTER_PROMPT_V3.md` (1926 行)

---

## 0. 一句话摘要

经过两轮共 **26 个子 agent** 的工作，树本身是**健康的**（两个包 typecheck 0 错误、全量套件 0 红），**但"通过"的判定反复被后续更严格的检验推翻**。本次请求的核心是：**请审计这套判定体系本身是否可信，并给出下一步的取舍决策**。

---

## 1. 项目目标与不变约束

**目标**：产出"上手即用"的 DSH（DeepSeek Harness）trusted-local 成品 —— Windows 本机、无沙箱、无 WSL、无 Linux VM、无 SSH 执行世界，**OS 用户账户即执行权威边界**。

**全程不变约束（用户原话，仍然有效）**：
- 不得泄露或打印凭证
- 不得未经授权消耗无限 API 预算、修改生产系统、push、部署、读取其他账户资料、扩大权限或关闭安全机制
- 没有可确认的 live API 授权/预算时，完成全部不依赖它的实现和测试，记录外部阻塞
- 保护已有用户文件、凭证和日用环境，不直接覆盖或升级
- 严禁把 `ctx.terminalController` 用作模型 Python 能力
- 不通过改 oracle、跳过测试、降低 N、扩大权限或假报结果取得 PASS
- 不要递归，不要对 CPU 有太严重的压力

**本轮新增授权**：删除 DSH 原生模式只留我们这一个；覆盖性推送到 `https://github.com/LEO001020/dsh`。

---

## 2. 权威实测状态（全部有命令与输出）

### 2.1 树健康度

| 项目 | 实测值 |
|---|---|
| `helpers/typecheck.mjs`（两包，含测试） | **PASS**，exit 0，92+24 文件 |
| daily-work 套件 | **1369 passed + 1 expected fail，0 红**（54 文件） |
| ipython 套件 | **104 passed**，3 个失败**仅在整套并发下**出现、单独跑全绿 |
| 非测试 `as never` | 2（基线允许 2） |

### 2.2 部署身份 — **不一致，需要决策**

```
lock 记录:        533c8cb0…
树重算:           不一致
  host_profile_digest  recorded 0e8e370e…  computed 4e3aa20c…
  （S1 的 includeShippedRoot: true→false 改动所致，是有意的）
```

**第二个身份输入从没有任何门检查**：
```
$ grep -c resolved_plugin_graph_digest helpers/rederive-identity.py helpers/doctor.py
0
0
```
而它绑定的 dump 是 `786edb1`（2026-09-19，**F3 修复之前**）的产物 —— 那个 dump 里 `sandbox-policy.mode` 仍写着 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，**正是 CMP-02 存在的意义所要抓的那个缺陷**。即：**这个身份输入既无人检查，又断言着缺陷存在**。

### 2.3 v2 判定表（S4，13 个原 FAIL 案例）

| 案例 | S4 判定 | **后续发现是否推翻** |
|---|---|---|
| ID-01 | PASS | 部分 —— G-SEAM-76：门是**基于解析**的，变量持有的 specifier 看不见 |
| ID-05 | **FAIL** | 否（S10 后来修了 6/7 个 mask，仍剩 1 个） |
| ID-06 | **FAIL** | 否（CRLF 伪差异，oracle 措辞无判断空间） |
| CMP-02 | PASS | 否 |
| CMP-04 | PASS | 否 |
| IPY-13 | **FAIL** | 是 —— S5 已实现，待合并 |
| IPY-15 | **FAIL** | 是 —— S6 已修 3 个真缺陷，待判定 |
| BR-07 | PASS | 否（但 S13 发现重启臂 1/4 失败率） |
| **DATA-09** | **PASS** | **是 —— S7 实测：四个阶段全部从产品不可达（G-SEAM-77）** |
| **DATA-11** | **PASS** | **是 —— D-1：游标 MAC 密钥可从公开描述符派生，我亲手伪造成功（G-SEAM-75）** |
| REC-09 | NOT_CLAIMED | 否 |
| REC-10 | NOT_CLAIMED | 否 |
| CAP-10 | PASS | 否（S9 在跑） |

**7 PASS / 4 FAIL / 2 NOT_CLAIMED，其中 2 个 PASS 已被推翻。**

---

## 3. 本次最严重的发现：D-1（游标 MAC 密钥可派生）

### 3.1 机制

```ts
// packages/dsh-daily-work/src/artifacts.ts:1905
function cursorSecretOf(descriptor: ObservationDescriptor): string {
  return `${descriptor.id}:${descriptor.captured.sha256}:${descriptor.authority.ownerScope}:${descriptor.authority.grantRevision}`
}
```

四个组成部分**全部是描述符字段**。而描述符：
- 由 `data:fs.capture` **交给调用方**（`data-bridge.ts:255`）
- 被 Python 客户端**原样保存**（`dsh_data_client.py:82`："Kept verbatim"）
- 在**每次分页调用时回传**（`:134, :148, :185`）

### 3.2 我的独立复现

从**公开描述符**重派生密钥，伪造一个 host 从未签发的游标（只改 `position` 64→500）：

```
field order in the HOST cursor: storeRealmId, artifactSha256, observationId,
  revision, representation, query, position, ownerScope, watermark, schemaVersion
host position: 64

FORGED: same shape, position 500, signed with the re-derived key
RESULT: *** ACCEPTED *** -- served offset 500 ( 64 bytes )
        the caller chose offset 500; the host never issued that cursor
```

**决定性细节**：我第一次用**排序后的键值**规范形式，**被拒了** —— 而"畸形 token 被拒"对密钥强度**毫无证明力**。真正的规范形式是接口字段顺序的 `JSON.stringify`（`artifacts.ts:1443`）。**停在第一次拒绝上会得出完全相反的结论。**

### 3.3 散文与代码相反

`artifacts.ts:1578-1581` 写着：
> "the secret is the only thing standing between a caller and a self-minted cursor naming any position in any artifact"

HMAC 构造本身**是正确的**；它用的密钥是公开的。

### 3.4 为什么 32 个绿臂没抓到

S8 的变异测试给出精确原因：**R7 的套件里没有一个臂测试"正确签名的伪造"**。所有臂都在**篡改 token**，所以全都触发 MAC —— 这证明 MAC **被计算了**，不证明它**保护了什么**。七个绑定字段确实拒绝签名伪造，但每个都同时与一个活值比较，所以那些拒绝**不是 MAC 在起作用**；`position` 和 `storeRealmId` 只与调用方自己的输入比较。

### 3.5 我自己早先的审计错了

`G-SEAM-73` 里记录着我曾对 R7 的游标 oracle 判定 **"SAFE, and structurally so"** —— 理由是 `CursorAuthority` 检查 MAC、schema、以及**对全部十个绑定字段的完整性谓词**。

**那个审计问的是"字段是否被正确枚举"，没问"密钥是否保密"。** 十个字段的完整性检查正是代码所做的，而当攻击者能自己算 MAC 时，它与安全性无关。

**由此得出的一般规则**：「枚举是否派生自产品自己的常量？」有用但**不充分** —— 一个 oracle 可以在结构上健全却**测错了对手**。缺失的问题是 **「对手不拥有什么？」**，它必须与「检查是否良构？」分开问。

---

## 4. 第二个严重发现：整个 `dsh.data` plane 从产品不可达（G-SEAM-77）

S7 驱动 DATA-09 的四个阶段时发现：

```
$ grep -c "data:" packages/dsh-ipython/src/bridge.ts
0
```

`data-bridge.ts` 导出了路由契约（`isDataRequest` :71、`routeDataRequest` :174），`data-plugin.ts:78` 再导出它。**但没有任何产品路径调用它们** —— `grep -rn 'isDataRequest'` 只返回定义、一个再导出、和测试。

而真正该分发 `data:*` 调用的 IPython bridge，其 `onCall()`（`bridge.ts:1094`）**无条件把每个 frame 送去 `ctx.tools.execute`**。

**另外三处断裂**（各自实测）：
- `dsh_data_client.install` 从未被调用（`bridge.ts:1245-1262` 只调 `_bind`）
- `.py` 不在 `package.json` 的 `files` 里
- `webFetch` 不传 `convert`，所以即使 router 通了，transform 阶段也没有 plane 路径

**后果的精确表述**：DATA-09 要求的四个 gap 阶段**在各自的 producer 处全部可产出且归因正确**（S7 逐个驱动、带控制臂、三个做了变异测试），**但没有一个能通过组装后的产品到达**。`ctx.dailyData` **确实**在真实启动时挂载了 —— 所以 **service 可达，没有任何 consumer 可达**。

这是本项目记录最多的缺陷类的**最完整形态**：不是**一个**没接线的函数，而是**整个 plane**（有自己的测试、客户端库、profile 行）产品进不去。

---

## 5. 判定体系本身的结构性问题（本次请求的核心）

### 5.1 `verify-spec.py --summary` 在完整检查红的情况下 exit 0

```
$ python qualification/runners/verify-spec.py --summary  > out 2>&1 ; echo $?
0
$ python qualification/runners/verify-spec.py            > out 2>&1 ; echo $?
1        # verify-spec: 317 problem(s).
```

summary 打印一个 **PASS 形状**的统计行（`BLOCKED_EXTERNAL=1, FAIL=13, PASS=95`）并 **exit 0**，同时存在 **317 个绑定问题**。一个 CI 步骤或读者跑 `--summary` 就得到绿灯然后停下 —— **说谎的正是那个门读的数字**。

### 5.2 门是"基于解析"的，看不见变量里的 specifier（G-SEAM-76）

`homelock.ts:126` 和 `:234` 故意把 specifier 放进变量（`const specifier = 'koffi'`），这样 TypeScript 不会去解析只在钉住检出区里存在的模块。**基于解析的门看不见它们。** 两者今天都解析到已构建产物，所以不是活缺陷 —— 但 `ID-01` 的 oracle 是关于**已解析图**的，而**看不见某个 specifier 的门无法为它作证**。

### 5.3 一个身份输入既无人检查、又绑着 pre-F3 的 dump

见 §2.2。

### 5.4 测试 pin 的是文档的 markup，而不是它的含义 —— 本轮出现两次

- **R9 的手选状态列表**（G-SEAM-73）：用 `grep -E "/to:\s*'(?:settling|confirmed|...)'/"` 认证"没有产品调用点指向终态"，**手选的枚举漏掉了 `unknown`** —— 产品真正写的那个状态。
- **`sec-gates.test.ts` pin `'CONFIRMED BY MEASUREMENT'`**：S14 的词汇规范化（其自身 header 要求状态格**必须以词汇词开头**）把这个全大写强调串换掉了，两个断言变红。**断言在 pin 一个强调标记，而它想 pin 的是"这是一次测量、且该条目仍是 OPEN"。**

**两次都通过了，直到某个无关的文本变动移动了它。**

### 5.5 一个间歇性失败的臂被当作证据

S13 实测 `r5-restart-epoch.test.ts`：四次**孤立**运行（同一 commit、无源码变更）→ **PASS / FAIL（63.7 s, KernelTransportError, 新进程只启动一个 kernel）/ PASS / PASS**。

这**推翻了 R5 自己的说法**（把臂移到独立进程后"该属性是确定性的"）。"长文件的第 20 个臂"这一解释被证伪 —— 它在孤立运行时也失败了，而负载假说恰恰说孤立应该安全。

我自己随后跑了 3 次，**全绿**。**这两者不矛盾**：1/4 的失败率下，3 次 0 失败的概率约 42%。**把我的绿灯报成"该臂稳定"正是本项目反复记录的那个错误。**

### 5.6 我自己犯的三个错误（已归档，保留而非清理）

1. **我给的指令是错的**：我告诉 S15 用相对 `name: ./probe.mjs` 修复跨树探针。S15 实测后指出：`ctx.baseUrl` 是**配置文件的目录**（`app-boot/src/index.ts:939` = profile 目录），相对路径会解析到 `$DSH_HOME/profiles/daily/`。**我引用了一个真实的上游测试作为依据，却没检查那个测试的 baseUrl 是什么。**
2. **我的 oracle 审计判错了**（§3.5）。
3. **R1 的提交信息里我写了没真正执行的验证**（声称 `tsc -p tsconfig.check.json` 干净；实测 1 个错误）。

---

## 6. 缺陷台账现状

`docs/GAPS.md`：**112 条目**（数字取自 S14 自己的审计工具 `qualification/results/S14-gaps/audit-gaps-hygiene.py`，它按**状态格的首词**分类 —— 这是 S14 建立的约定；手写正则得到的数字与它不同，因为手写会把正文里出现的词也算进去）：

| 状态 | 数量 |
|---|---|
| OPEN | **39** |
| RESOLVED | 43 |
| IN_PROGRESS | 8 |
| FIXED | 5 |
| BLOCKED_EXTERNAL | 3 |
| VERIFIED | 3 |
| DUPLICATE | 2 |
| RETRACTED | 2 |
| SUPERSEDED | 2 |
| CLOSED BY DELETION | 1 |
| REFUTED | 1 |
| PARTIAL | 1 |

`malformedRows: 0`，`noVerdictEntries: []` —— 即每个条目都带有一个可机读的判定。

**39 个 OPEN 是本次请求需要决策的主要对象。** 其中本轮新发现的严重条目：

| ID | 内容 |
|---|---|
| G-SEAM-75 | D-1 游标 MAC 密钥可派生（§3） |
| G-SEAM-76 | ID-01 门基于解析，变量 specifier 不可见（§5.2） |
| G-SEAM-77 | 整个 dsh.data plane 产品不可达（§4） |
| — | 绝对 `name:` = 跨树**代码执行**（41 个 patch 文件：26 指向主树、15 指向第 1 轮写入者的临时工作树） |
| — | 身份输入 `resolved_plugin_graph_digest` 无人检查且绑 pre-F3 dump（§2.2） |

---

## 7. 已确认合格的部分（不是全部都是坏消息）

| 项目 | 证据 |
|---|---|
| **A12 真实日用 Web host** | 我实测：启动、监听 3080、应答 HTTP、**持续运行**、**stderr 为空**。三次请求确立认证门：无 token→401、坏 token→401、**有效 token→303**（`401≠303` 才证明认证门存在，前两者单独看与"服务器拒绝一切"无法区分） |
| **单一模式（用户核心诉求）** | 实测 roster `[standard, ptc, minimal, cordis, daily-standard]` → **`[daily-standard]`**；四个原生 id 抛错；我们的 preset 仍挂载（27 工具、0 激活警告）。**诚实边界：删的是我们自己 composition 的暴露面，钉住检出区未被改动** |
| **F3（模式说谎）** | `danger-full-access` + 三个边界上的守卫；启动边界曾**静默**（丢弃的 `ctx.inject` 子 fiber），已修复为 LOUD |
| **F5（目标超额准入）** | `tryReserveAdmission` 在**一个** storage-domain update 内 |
| **F2（BridgeServer 不可达）** | 真实 daily 启动到达活的 bridge（端口 4191），台账记录 `disposition: settled` |
| **D-1 的对照面** | DATA-11 自己的 oracle 臂**全部成立**（跨 store 拒绝、跨 revision 拒绝、每类拒绝都被记录、16 进程 + 8 真实 OS 进程竞争一个 root 得到**一个** realm、realm 在 mint 与 replay 之间被替换则双向拒绝） |

---

## 8. 请求 GPT Pro 解决的决策问题

### Q1（最高优先）：D-1 的修复方案
游标需要一个**不能从描述符派生**的密钥。候选：
- store 自己的持久 realm 文件（调用方读不到的文件）
- host 进程内存中的密钥
- 其他？

**请给出方案，并说明每个候选的弱点。** 注意：修复必须同时满足 DATA-11 自己的 oracle（§7 的对照面），不能削弱其中任何一条。相关文件：`packages/dsh-daily-work/src/artifacts.ts`（`cursorSecretOf` :1905、`CursorAuthority` :1433-1586、`assertRealm` :1513）。

### Q2：`dsh.data` plane 不可达（G-SEAM-77）—— 修还是删？
四个 gap 阶段全部只在测试中可达。选项：
- (a) 把 router 分支接进 `bridge.ts` 的 `onCall()`，让 plane 真正可达
- (b) **删除整个 plane**（连同它的测试、客户端、profile 行），因为一个产品进不去的平面是纯负债
- (c) 保留但明确标注为"未接线"

**V3 的原则是"不要为通过案例而修案例，要么接线要么删除"。请裁决。** 注意 §2.3 中 DATA-09 被判 PASS 而现在已被推翻。

### Q3：判定体系的可信度
鉴于 §5 的六项结构性问题（尤其是 §5.1 的 `--summary` 假通过、§5.4 的 markup-pin、§5.5 的间歇臂）：
- **这套判定体系还能作为发布依据吗？**
- 需要什么样的元级别门（meta-gate）来防止"门通过而东西是坏的"？
- 具体地：如何让一个门无法在"存在 N 个问题时"exit 0？

### Q4：39 个 OPEN 条目的取舍
请给出分类处置原则：哪些必须现在修、哪些可以带病发布并记录、哪些应当**删除机制**而不是修（V3 对 REC-09/10 采用了删除，因为守卫的输入无法构造）。

### Q5：`resolved_plugin_graph_digest` 绑着 pre-F3 dump（§2.2）
需要一个新的 dump 产物 + 一个检查。**但 S3 正确地拒绝制造一个 dump 来让 pin 吻合**（那是"改变被测量之物"）。请给出正确的修复顺序与证据要求。

### Q6：跨树代码执行（41 个 patch 文件）
绝对 `name:` 会让一个树启动时**执行另一个树的探针**。S15 修了 18 个，**8 个未修**（其调用方在 `qualification/results/**` 的已记录历史里，改它就是改历史）。S15 的表述我保留：**"已记录并有界，但不可接受"**。请裁决这 8 个怎么处理。

### Q7：发布决策
树是健康的（0 红、0 typecheck 错误），但 **2 个被判 PASS 的案例已被推翻**、身份不一致、51 个 OPEN。**这个状态适合发布到公开仓库吗？** 如果适合，应该以什么措辞发布（即：如何诚实标注已知缺陷而不误导读者）？

---

## 9. 附：当前未完成项

| 项 | 状态 |
|---|---|
| `wt/s5`（IPY-13 实现） | 9 commits，**已交回待合并** |
| `wt/s9`（CAP-10 风暴 + R4 测到的 1→0 回归） | 在跑 |
| `wt/s16`（D-1 修复） | 在跑 |
| 身份重派生 | 待做（S1 改动后需重新采纳） |
| 推送 5 agent（P1 凭证 / P2 体积 / P3 可推 / P4 推送 / P5 独立验证） | 在跑，P4 等三个 GO 门 |
| R10 终局矩阵 | 未跑 |

**安全边界（仍然有效）**：没有 push、没有部署、没有对外发布；没有凭证被打印或入库；钉住检出区工作树未被写入（`.git` 被写过两次 —— 一次是 S12 的惰性抓取，一次是原因不明的 pack 重写，均已记录）；没有修改生产系统或扩大权限。
