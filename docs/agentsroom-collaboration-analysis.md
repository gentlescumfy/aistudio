# AgentsRoom 项目与代理协作分析（REA 逆向报告）

> 工具：REA v6.1.0（`npx rea-agents@latest`，https://github.com/morluto/rea）
> 分析对象：本机安装的 AgentsRoom 桌面应用（v1.202.0）及其在本仓库落下的运行态数据
> 分析时间基准：`main @ 608f794`
> 结论分级：**[静态证据]** = 源码/文件可直接举证；**[REA 证据]** = REA 报告可直接举证；**[推断]** = 由前两者推导，未经运行时验证

---

## 0. 执行摘要

AgentsRoom 的协作能力**不在本仓库的自研层里**，而在桌面应用随包发布的
`resources/*.cjs`（约 1.1 MB 的零依赖 CommonJS）里；本仓库 `D:\aidev\aistudio\aistudio`
只是它的**被协作对象**：`AI Studio` 提供业务面，`.agentsroom/` 提供项目态数据面。

三条主轴构成全部"代理间协作"：

| 主轴 | 载体 | 作用域 | 持久的最终结果 |
|---|---|---|---|
| **Agent Team（结构化流水线）** | `team-mcp-server.cjs`（10 个 `team_*` 工具） | 一次 run | `handoff payload` → 下一节点 |
| **Agent Mail（非结构化同事通信）** | `app-mcp-server.cjs`（7 个 `agents_*` 工具） | 项目内的"代理组织" | 消息落盘 + backlog 评论 |
| **人机闭环（HITL）** | session file / `notify_user` / `agents_ack` | 用户 | 侧边栏状态 + 手机推送 |

三者共享同一套"防跑偏"设计哲学：**每个上限都会向模型解释为什么拒绝**，因为唯一的
读者是语言模型，而 `retry later` 对循环护栏恰好是错的修复方式。[静态证据]

**对本仓库最相关的结论**：`docs/project-scoped-refactor-plan.md` 提出的"方案 A（Project
隔离 + 治理网关）"目前**一行都还没落地**，且与 AgentsRoom 已经提供的 `AR_PROJECT_ID`
项目隔离机制**存在重复建设风险**——见 §6.3。

**第二轮增补（§11）**：解开 `app.asar` 并美化主进程 bundle（125,702 行）后，第一轮全部
"未验证"缺口已补齐——权威状态枚举、循环护栏、信号扫描、Agent Mail 磁盘布局与限制强制点
均实测确认；同时发现 5 处**契约/文档与实现不符**：`maxCycles` 运行器无默认值、
信号文件名不按 agentId 编码、`console-missing`/`agent-silent` 无写入者、
协调者额度 36/90 未见于文档、`continuationProven` 桌面侧从不校验。

**架构层（§12、§13）**：模型切换的上下文交接为**三层降级**（代理自写总结 → 终端转录 →
基础元数据，§12）；整体架构为"**桌面端编排 + 外置 CLI 代理 + 磁盘文件真相**"：
5 个零依赖 MCP sidecar、13 个 per-provider 配置写入器、15+ 种可替换 CLI、
项目/全局/云三域数据面（§13.1–13.6 给出完整拓扑与通信矩阵）。

**团队专题篇**：`docs\agentsroom-team-analysis.md` —— 专答"团队是什么"：数据模型
（`mode`×`routing` 双维度、13 字段记录面）、存储与限额（1 MB/团队、14 MB/项目列表、
`runOnce` 自删、"1161 团队"事故复盘）、`teams_*` 管理面（dryRun / structure 视图防呆 /
16 条阻塞规则）、**治理守卫**（活 run 中团队定义与 skills 对代理只读、双信号溯源、
`GUARDRAIL ACTIVE` 工具注记）与 REA 交叉验证（758,805 AST 节点 / 21 处 `setInterval` /
0 处 sidecar 定时器）。

---

## 1. 方法与可复现命令

### 1.1 REA 可用性

```
npx -y rea-agents@latest --help      # v6.1.0，119 个子命令
npx -y rea-agents@latest doctor      # healthy: false
```

`doctor` 的实测结果（原文摘录）：

| 检查项 | 结果 | 说明 |
|---|---|---|
| node | ok | 24.11.1 |
| host | ok | win32 x64 |
| hopper / ghidra / ida | **false** | `missing_analysis_engine` |
| skill:identity | false | `config_drift`：REA skill 身份缺失 |
| registration:claude_code / codex / gemini_cli / antigravity / copilot_cli / vscode | false | 均为 `config_drift` |

**关键限制**：本机**没有任何原生反汇编引擎**。因此 `open_binary` / `function` /
`decompile` 等原生分析路径在本机不可用，本次分析**只使用了纯静态 JavaScript 路径**，
`analyze-javascript-application` 不需要 Hopper/Ghidra/IDA。[REA 证据]

### 1.2 REA 调用方式（踩坑记录）

PowerShell 下直接 `npx ... | Out-File` 会被进度输出污染并把 stdout 混进 stderr 包装，
且整包分析输出可达 **400 MB**。可用做法（本次实际使用）：

- 辅助脚本 `run-rea-direct.mjs`：`spawnSync` + `openSync(outFile,'w')` 直接把子进程
  stdout 写到文件，绕开 PowerShell 管道。
- **必须传目录**：`analyze-javascript-application <path> --artifact-format directory`；
  传单个 `.cjs` 文件返回 `status 1` 且无输出。故每个目标文件被单独放进一个同名目录。
- 输出必须裁剪：平铺的 `--filter-output` 子树路径无效（返回 `{}`），只有
  `summary` / `statistics` / `limitations` / `graph.*` 这类复合键可用。实际做法是先
  `--format md` 全量落盘，再用 `Select-String '^## normalized_result\.'` 枚举 JSON 路径，
  最后按需切片。

### 1.3 实际跑过的分析

| 目标 | 模式 | 输出规模 |
|---|---|---|
| `C:\Users\Hi\AppData\Local\Programs\AgentsRoom`（整包） | `analyze` | 400 MB / 388,591 行 |
| `resources\team-mcp-server.cjs` | `analyze-javascript-application` | 2.5 MB |
| `resources\agentMailMcpTools.cjs` | 同上 | 63 KB |
| `resources\agentMailCheckpointMcp.cjs` | 同上 | 296 KB |
| `resources\agentSaveMcpTool.cjs` | 同上 | 1.4 MB |
| `resources\agentRestartMcpTool.cjs` | 同上 | 456 KB |
| `resources\agentConnectionScope.cjs` | 同上 | 177 KB |
| `resources\notifyUserMcpTool.cjs` | 同上 | 443 KB |
| `resources\sessionFileMcpTool.cjs` | 同上 | 637 KB |
| `teamRunStore/teamsGraphOps/teamsGraphView/teamRunStallGuide.cjs` | 同上 | 160–777 KB |

整包分析的 `normalized_result.summary`（[REA 证据]，来自
`## normalized_result.summary.*`）：

```
statistics: relevant_files 2119, text_bytes_read 50,632,505,
            parsed_javascript_files 2069, visited_ast_nodes 5,992,235,
            findings 47,393, modules 0, parse_failures 0, invalid_utf8_files 12
browser_windows 4, explicit_web_preferences 16, preload_entrypoints 1,
context_bridge_apis 2, exposed_api_members 190,
ipc: operations 1209, literal_channels 652, dynamic_channel_operations 34,
     renderer_transmissions 525, main_handlers 520,
     paired_renderer_transmissions 503, ambiguous 0,
     unpaired_literal_renderer_transmissions 15
sender_validation_observations 30, utility_processes 0, native_addon_bindings 0
graph_id jag_95821c082ddf478e5db64efd3ffb78ec4dae77eea8d636c8ee92f2e66562b97e
subject.digest sha256 beb8f1bb175c8cc7b466868650e1eeb3a43e356be9951e6a03057288d0b71211
```

---

## 2. REA 能做什么、不能做什么（本次最重要的方法论发现）

REA 在 JavaScript/Electron 目标上产出的是**结构图**（module / import / expose 边）与
**语义图**（`call-site` / `binding` / `literal` / `expression` / `property-slot` 节点）。
它**能把工具描述字符串整体抓成一个 `literal` 节点，但不会建立"这个字符串是一个工具
的名字与用途"这层语义**。

我用整包 REA 输出（400 MB）独立复核了这一负结论：

```
team_complete_step          0 次
StdioServerTransport        0 次
AGENTSROOM_TEAM_RUN_ID      0 次
agents_send                 2 次  ← 仅出现在两段被当作 literal 的描述文本里
```

那 2 次 `agents_send` 命中的行（原文摘录）：

- `L111303`：`" The answer also carries \`projectInbox\` ({ waiting, coordinators }): the PROJECT's own inbox…"`
- `L162547`：`"Mark this agent as the project's COORDINATOR: the agent that directs the others. It sends under a RAISED Agent…"`

即：REA 抓到了**描述文本**，没有抓到**工具名录、工具语义、状态机、数值上限**。
其自述局限恰好解释了原因（`normalized_result.limitations`，九个文件逐字相同）：

1. CommonJS/ESM 绑定关系来自惰性语法，仅在已清点容器内解析
2. JavaScript 与 HTML 按惰性文本解析；**bundle 引导代码从未执行**
3. 静态 import/入口/worker/端点/存储关系**不证明运行时执行**
4. **表达式动态或混淆时，静态路径与关系可能保持未解析**
5. Webpack/Rspack 工厂来自 AST 字面量，未触发其 push handler

`semantic_graph.limitations` 补充了直接命中的两条：*"Event extraction covers
EventEmitter-style literal registrations… **dynamic names remain unknown**"*、
*"**Local data flow does not claim control-flow-sensitive reaching definitions or
arbitrary dynamic property resolution**"*。

**结论**：AgentsRoom 的协作协议恰好落在 REA 的能力缺口上——协议由
(a) `TOOLS` 数组里的字符串字面量和 (b) `switch (name)` 动态分发承载。
因此下文所有协议语义均标注为**源码举证**，REA 只用于：

- 整包的 Electron **边界清单**（4 个浏览器窗口 / 1 个 preload / 2 个 contextBridge API /
  **190 个 `exposed_api_members`**）；
- **IPC 面盘点**：1209 个 operation、652 个字面 channel、520 个 main handler、
  503 对可配对、**15 个未配对**、34 个动态 channel 表达式；
- **安全观察**：30 处 sender 校验观察（REA 明确声明这**不证明**存在完整授权策略）；
- 单文件的常量值、字段名、函数名、环境变量名字面量（可作廉价交叉验证）。

整包 `normalized_result.graph.limitations` 里必须并读的两条：*"Static imports,
entrypoints, workers, endpoints, and storage relationships do not prove runtime
execution."* 与 *"Sender, frame, URL, and origin checks are observations only; REA
does not claim that they enforce a complete authorization policy."*

---

## 3. Agent Team：结构化流水线（`team-mcp-server.cjs`，66 KB）

### 3.1 十个工具（源码举证）

`TOOLS` 数组位于 492–694 行，`tools/list` 在 **1367 行**按 `TEAM_ENV_OK` 决定是否广播；
未满足环境变量时**完成握手但广播零个工具**并只向 stderr 说明一次（第 128–143 行的
注释解释了为什么不再 `process.exit(1)`：那会让每次非团队会话报一个吓人的 MCP 启动错误）。

| 工具 | 定义行 | 用途 |
|---|---|---|
| `team_get_context` | 494 | 当前步骤上下文：角色、cycle、入站 handoff payload、`currentStep.stepInstructions`；被明确定位为"抗上下文压缩的回归契约之路" |
| `team_read_notes` | 500 | 读共享 `NOTES.md`（默认 20000 字符，`from: tail\|head`，`offset` 分页） |
| `team_post_note` | 526 | 追加 markdown 到 `NOTES.md`（≤6000 字符，**仅追加，不能编辑或删除**） |
| `team_read_timeline` | 538 | 有序事件日志（`run-started` / `node-entered` / `handoff` / `run-ended`） |
| `team_read_inbox` | 549 | 读发给"你的角色"或 `any` 的消息（`sinceSeq`，**不自动清游标**） |
| `team_roster` | 563 | 队友清单：角色（即地址）、显示名、是否有活跃控制台、`canWriteTo`、`readOnly` |
| `team_send` | 569 | 发给 1..N 个角色或 `*`；`expectsReply` **只允许一个收件人** |
| `team_ask` | 595 | 旧的单收件人形式，委派给 `toolSend`（1081 行） |
| `team_read_diff` | 611 | 相对 run 起点基线（或当前步骤起点）的 git diff，封顶 60 KB |
| `team_complete_step` | 627 | **触发下一节点的唯一要求**；结构化且强校验的 payload |

协议为 stdin/stdout 上的 JSON-RPC 2.0 行分隔（`readline`，1347 行），
`protocolVersion '2024-11-05'`，`serverInfo.name = 'agentsroom-team'`，
`SERVER_VERSION = '1.1.0'`（88 行）。

### 3.2 协作原语：两种模式，两条通道

**通道一 —— 交接（hand-off）＝ 文件投递箱，无回调**

`team_complete_step` 写一个信号文件（`step-complete.json`，并行分支为
`step-complete-<agentId>.json`，1254–1256 与 1287 行），对象形状
（1266–1278 行）：

```json
{ "runId": ..., "nodeId": ..., "agentId": ..., "cycle": ...,
  "writtenAt": ...,
  "payload": { "featureSummary": ..., "risks": [...], "testHints": [...],
               "flags": {...}, "nextNodeHint": ..., "workspaceCwd": ... } }
```

**运行器是另一个进程，靠轮询这个文件推进——没有回调通道。** 源码第 1168 行原文
把这一点写成 *"file drop-box, no channel back"*。这解释了 3.5 节全部
"未读到信号"类缺陷的存在理由。

**通道二 —— 通信（coordination）＝ 每个收件人一个 inbox 文件**

`team_send`（`toolSend`，979 行）在 `inbox/` 下写
`<seq 补零 6 位>-<from>-to-<to>.json`（1021 行），形状
`{seq, at, fromRole, fromNodeId, toRole, toRoles, question, expectsReply}`（1026–1035 行）。
`isMessagingRun` 判定 `state.mode === 'messaging'`（839 行），两种模式语义不同：

- **messaging 模式**：每个代理为**一个**节点而启动、永不改变角色；`state.agents[]`
  记录其身份。消息**实时投递到对方控制台**，"尚无控制台的队友会被启动起来以便回答"
  （571 行）。
- **relay/morphing 模式**（`mode !== 'messaging'`）：一个会话依次扮演每个角色；
  一条消息"是留给下一个扮演该角色者的便条，而不是实时对话"（969–970 行）。

**等待的正确姿势**：`expectsReply: true` 时"**结束你的回合**，而不是轮询
`team_read_inbox`"（1065–1070 行）——回复会以 `TEAM MESSAGE` 形式到达并开启新回合。

### 3.3 身份解析：环境变量在 spawn 时冻结，`state.json#currentStep` 才是真相

这是全文件最微妙的部分（第 183–261 行的长注释）：

- PTY 环境变量在 spawn 时冻结，但 v3 的"单代理角色变形"让**同一个代理在每个步骤换角色**，
  因此 `NODE_ID` / `ROLE` 只描述**第一步**。
- 环境变量前缀二选一：有 `AGENTSROOM_TEAM_RUN_ID` 用 `AGENTSROOM_TEAM_`，
  否则用 `AGENTSROOM_TEAM_BAKED_`（110 行）。**两者绝不混用**——注释记录了一个真实
  缺陷：应用重启同时拉起多个团队控制台时，最后写入的 baked 配置覆盖了所有人，
  某个控制台用**另一个团队的 run** 回答了 `team_get_context`。
- 自禁用护栏只要求三个值：`RUN_ID && AGENT_ID && WORKSPACE`（139 行，`TEAM_ENV_OK`）。
`NODE_ID` / `ROLE` 被**故意**不设为必需，因为它们可从 `state.json` 动态解析。

`stepNodeId`（236–261 行）的六级解析链：

1. `myRosterStep` —— messaging 模式下按 `AGENT_ID` 查 `state.agents[]`
2. `myParallelStep` —— 并行分支按 `AGENT_ID` 查 `state.parallelSteps`
3. messaging 模式下的 `NODE_ID`（"`agents[]` 条目可能因并发 read-modify-write 丢失"的安全网）
4. `state.currentStep.nodeId`
5. `myFinalStep(s, AGENT_ID)` —— run 在该代理的步骤上等待用户收尾
6. `NODE_ID || ''`

`stepRole`（263–280 行）镜像同一顺序。第 236 行的注释记录了一个真实身份串号缺陷：
并行兄弟节点与 messaging 队友都曾用**邻居的角色**回答并可能**替邻居签收步骤**。

同一文件还有一处被显式承认的竞态（756–761、1041 行）：**多个 MCP 进程与团队提醒钩子
并发地对 `state.json` 做 read-modify-write**（`noteCount` 765–768、`inboxCount` 1041）。

### 3.4 状态机与持久化

`state.json` 的完整状态枚举位于桌面端 TypeScript，本包只直接出现
`RUN_OVER_STATUSES = new Set(['done','cancelled','blocked'])`（1146 行）与
`'awaiting-finalization'`。完整枚举来自 `teamRunLifecycleContract.cjs`（源码举证）：

| 状态 | 含义 |
|---|---|
| `pending` | run 已建，首步未启动 |
| `running` | 某步骤正在执行 |
| `awaiting-handoff` | `handoffMode:"manual"` 的步骤已完成，等用户点 Hand off |
| `awaiting-user` | 停在 await 节点等人类回答。**这是刻意暂停，不是 stall**：不要取消，且**没有任何工具能回答它** |
| `awaiting-finalization` | 所有 agent 节点已完成；控制台被**故意保留**。调 `team_finalize_run` 收尾，或 `team_cancel_run` 中止。收尾前"终结该 run 的那一步"可用新 flags 再次 complete 从而**重开 run** |
| `blocked` | 无法推进（命中 `maxCycles`，或某步失败） |
| `done` / `cancelled` | 终态 |

**run 目录**（全部路径相对 run 目录，147–158 行）：

```
<STATE_ROOT>/.agentsroom/team-runs/<RUN_ID>/
    state.json            步骤/角色/状态真相
    NOTES.md              共享可追加便签
    inbox/                每个收件人一个消息文件
    timeline.jsonl        事件日志
    step-complete.json    交接信号投递箱
```

`teamRunStore.cjs` 把这四个操作（`readText/writeText/appendText/listDir`）抽象成
**本地 fs 或 SSH 隧道远端桥**两种实现，远端通过 worker 线程 + `Atomics.wait` 保持
**同步**语义（因为 server 本身是同步程序，改成 async 要动每一处 `state.json` 读取）。
失败语义刻意不同：**文件缺失 → `null`/`[]`，但桌面不可达 → 抛错**，让工具以"指名隧道"
的信息失败，而不是报告"状态不存在"。

### 3.5 护栏：每个上限都会解释为什么

数值上限集中在 337–353 行，并在 `COMPLETE_STEP_LIMITS`（362–366 行）**同时写进工具
描述和每一条校验错误**——注释明确说明理由：*"调用者事先看不到的上限，就是一次因无法
预见的理由而失败的调用"*。

| 常量 | 值 | 备注 |
|---|---|---|
| `MIN_SUMMARY_CHARS` | 40 | 低于此值拒绝，并给出实际字符数与"写至少多少" |
| `MAX_SUMMARY_CHARS` | 1500 | |
| `MAX_LIST_ITEMS` | 20 | `risks` / `testHints` 各自 |
| `MAX_LIST_ITEM_CHARS` | 600 | **从 300 提上来的**：300 太紧，代理为了过校验把真实安全发现压缩改写；错误信息现在是"拆成多项，而不是缩短" |
| `MAX_FLAG_KEYS` | 20 | |
| `MAX_NOTE_CHARS` | 6000 | |
| `MAX_QUESTION_CHARS` | 1500 | |
| `MAX_WORKSPACE_CWD_CHARS` | 1024 | "路径不是报告" |
| `MAX_RECIPIENTS` | 20 | |
| diff 封顶 | 60 KB | 溢出是**截断而非失败**，末尾给出续读命令 |
| `GIT_TIMEOUT_MS` | 20 s | 单线程 stdio 进程：一个卡住的 git 会拖垮所有工具调用 |

四类门禁：

1. **路由门禁**（`teamRouteCheck.cjs`）：当步骤的所有出边都是条件边、而报告**一个都没提到**
   它们测试的 flags 时**拒绝**，并点名应该报哪些 flag；当报了但**值不匹配任何路由**时
   **接受**，凭条说明 run 会停在这里以及如何用别的 flags 重开。拒绝 / 接受的分野刻意如此。
2. **每 cycle 单次完成**（`teamPendingCompletion.cjs`，`PENDING_SIGNAL_FRESH_MS = 60_000`）：
   投递箱在 60 s 内仍有同 run/node/cycle 的信号 ⇒ 拒绝，"第一次生效"。
3. **发送预算**（`teamSendBudget.cjs`，与 Agent Mail 同源）：`SEND_WINDOW_MS = 10 min`、
   `MAX_SENDS_PER_WINDOW = 12`、`MAX_FANOUT_PER_WINDOW = 30`、
   **`MAX_PAIR_PER_WINDOW = 10`**（一对角色双向合计；注释："真正的问答是 2–6 条，
   十分钟十条就是两个代理在礼貌地互相道谢"）、`RESEND_GUARD_WINDOW_MS = 1 h` 去重。
   `STOP_INSTRUCTION` 明确禁止 retry/reword/拆散广播，因为"retry later 对循环护栏恰好是错的修复"。
4. **问题不可广播**（`questionFanOutRefusal`，1007 行）。

### 3.6 图契约：路由、并行、循环、人为闸门

来自 `capabilitiesTeamsContract.cjs`（源码举证，由 `teamsMcpTools.cjs` 注入同一批常量以保证
契约不会与实际执行的规则漂移）：

**节点类型**：`start`（恰好一个，唯一出边，**出边不能带条件**——首步之前不存在任何 flag）、
`agent`、`await`、`end`、`group`（纯视觉，运行器忽略）。

**flag 才是唯一路由依据**，且**没有 flag 注册表**——某个 flag 之所以存在，只因为某步发过它。
三个生产者：

1. **代理**：`team_complete_step({flags})`，名字与值自定（正常路径，须把 flag 名**逐字**写进
   步骤指令，否则该步无从得知）。
2. **人类**：await 节点的条件出边被**渲染成答案框里的选项**，选中即把该边条件写入 flags。
3. **运行器（测量门）**：带 `checkCommand` 的节点由**运行器**执行命令，退出 0 写
   `flags[checkFlag]=true`，否则 false——**实测结果覆盖代理自报**。门限按**静默**而非时长切断
   （`checkIdleTimeoutSec` 默认 120，每收到一个字节就重新计时），被切断时额外写
   `flags.checkTimedOut=true`。

**出边解析顺序**（`edgeResolutionContract`）：

1. 收集刚完成节点的所有出边
2. **无条件边 = 默认路由（兜底）**
3. 条件边按 `conditionMode` 组合：`all` = AND（默认），`any` = OR
4. 多条条件边同时命中时，**最具体者胜出**：`all` 每条条件得 1 分，`any` 得 1 分
   ——"细化分支靠**加条件**，绝不靠调整边的顺序"
5. 无条件边也不匹配时：**run 停在该节点**，进入 `awaiting-finalization` 并被打上
   `stalled: no-route`，**未到达 End**，直到该步用别的 flags 重开或用户介入

**并行扇出**：一个 agent 节点的**两条以上无条件出边**并行执行。约束：每个分支目标必须是
agent 节点；每个分支恰有一条无条件出边（其汇聚边）；所有分支必须汇聚到**同一个** join 节点；
`start` 永不扇出。配套告警 `fanout.sharedTree`：多个分支在同一工作树同时跑且至少一个可写时，
必须在可写/可测量的分支上设 `ownWorktree: true`。

**循环**：条件边指回更早的节点即是 QA→Dev 返工环；护栏为团队级 `maxCycles`（**默认 3**），
超过则 run 转 `blocked`。

**`needsInput: true` 是唯一保留 flag**：它**不参与路由**，只让 run 在**上报该步**上为人类暂停，
其余 flags 照常路由。

**16 条阻塞规则**（`blockingRules`，与 `validateGraph()` 一一对应）与 **3 条告警**，
其中 `node.noFallback` 尤为重要："agent 节点的每条出边都是条件边：若无条件命中，run 就停在
那里。请加一条无条件兜底边。"

### 3.7 停顿诊断：7 个原因，每个都给"下一步动作"

`teamRunStallGuide.cjs` 的 `GUIDE`、`app-mcp-server.cjs` 的 `backlog_get` 与
`capabilitiesTeamsContract.cjs` **共享同一份文案**，以免三处对同一个 stall 说法不一致：

| reason | 含义 | 动作 |
|---|---|---|
| `no-spawn-ack` | 已派发给桌面但从未确认打开控制台 | 确认桌面在运行并打开了此项目；仍无则 `team_cancel_run` |
| `console-missing` | 该步无可用控制台 | 打开项目让控制台启动，或 cancel |
| `delivery-failed` | 简报写了好几次、代理毫无反应 | 用 `agents_send` 让该代理调 `team_get_context()` → 应用 payload → `team_complete_step` |
| `awaiting-input` | 该步代理卡在自己控制台里对用户提的问题上 | **只有人类能回答，不要因此取消 run** |
| `agent-silent` | 结束了回合却没调 `team_complete_step`，且忽略两次提醒 | `agents_send` 提醒，或确认放弃后 cancel |
| `no-route` | 报告的 flags 不匹配任何出边且无默认路由 | **不要盲目收尾**；让该代理用匹配的 flags 重新 complete（会重开 run） |
| `reply-missing` | 某代理 `expectsReply:true` 后队友被提醒仍不回答 | `agents_send` 提醒被点名的队友 |

该文件明确写着：停顿是**"一个标志，而不是终结"**——run 状态完好、仍可编排，多数标志会自行解除。

### 3.8 收尾、重开与续命

- **重开（reopen）**：run 处于 `awaiting-finalization` 且**终结它的那一步属于你**时，再次
  `team_complete_step` 会用新 flags **重开 run**——真实案例是"QA 通过后 run 到了 End 等用户
  收尾，QA 又发现一个缺陷，`team_send` 只留下一条没人会读的中继便条，而
  `team_complete_step({qaPassed:false})` 回答"步骤已标记完成"却被运行器忽略，用户只能手动
  重启开发者"。`team_send` 单独调用在这里**什么都推动不了**。
- **MCP 侧收尾**：`team_finalize_run({runId})`（等同于点"Finish run"：关闭 run 记录、
  拆除临时节点控制台、把来源 backlog 单据移到 done）与 `team_cancel_run`（立即结束，
  **不动**来源单据——取消的语义是"这次 run 没产出可用结果"）。**未到
  `awaiting-finalization` 的 run 拒绝被 finalize**，因为 finalize 等于把工作记为已完成。
- **续命**：`team_extend_run({runId, cycles:1|2, reason})` 只在团队开启
  `agentExtraCyclesMax`（**默认关闭**，上限 10）时可用，且是**唯一**能继续 run 的生命周期
  工具——**没有任何工具能回答 `awaiting-user`**。

---

## 4. Agent Mail：非结构化同事通信（`app-mcp-server.cjs`）

### 4.1 七个工具（源码举证，`agentMailMcpTools.cjs:53-295`）

| 工具 | 行 | 用途 |
|---|---|---|
| `agents_list_live` | 55 | 本项目代理组织的名册：每个已保存代理、是否有活跃 CLI 会话、自称在做什么、**积压未取邮件数**；**跨所有 CLI** |
| `agents_send` | 75 | 发给一个/多个/`*`/`inbox`；**先持久化后投递**；立即返回 `messageId`；**不等待** |
| `agents_message_status` | 156 | 每个收件人的真实状态：`queued`/`delivered`/`read`/`accepted`/`rejected`/`replied` |
| `agents_read_inbox` | 181 | 读自己的收件箱；**读取即标记已读并告知发送者** |
| `agents_reply` | 226 | 在同一条线程内回答；在原消息上记录 `replied` 回执 |
| `agents_ack` | 246 | `accepted`/`rejected`（拒绝必须给理由，否则阻塞发送者）；ack 同时标记已读 |
| `agents_report_status` | 265 | 自报 `idle\|busy\|blocked\|rate_limited\|degraded\|failed` + `workPhase`/`blockedReason`/`backlogTaskId` |

**为什么挂在 `AgentsRoom-MCP` 而不是自建 server**（原文）："新 server 意味着多三条打包条目，
以及十三个 per-provider 配置写入器里各多一个条目。挂在 `AgentsRoom-MCP` 上，则每个 harness
的每个代理在发布当天就拿到这些工具，零接线。"

**投递模型**：**全部走本地桥，无一条走云**。理由是一个邮箱"本地才自然：收件人是本机的控制台，
且离线也必须可投递"——这与 backlog/memory 家族**刻意相反**（后者云优先，以便应用关闭时仍可用；
但邮箱在应用关闭时本来就没有投递对象）。

**身份与防伪**：`callerAgentId` 由 server 自己的 `AGENTSROOM_AGENT_ID` 盖章，
**刻意不出现在任何 schema 里**——"代理不得以同事的身份发信，而工具参数正是它唯一能这么做的途径"。

**为什么不能用 CLI 自带的会话工具**：Claude Code 的 `ListAgents`/`SendMessage`
"只能看到本机**同一 CLI** 的会话，所以跑 Codex/Gemini/Cursor 的同事对它隐性不可见，
而这会让人错误地断定对方不可达"。AgentsRoom 邮箱是**唯一跨 CLI 的名册**。

**静默的两种相反含义**（`agents_message_status` 的描述）："尚未投递（队列正在处理）"与
"已读但刻意不答（只有你的用户能推动它）"——从发送侧看**完全一样**，猜错很贵：
"同一指令到达两三次，尤其来自多个会话，与'试图把拒绝磨穿'无法区分，会以此为理由被拒绝。"

### 4.2 线程与关联

- **线程 = `inReplyTo` 链 + subject**：`agents_reply` 设 `inReplyTo: messageId`；
  主题经 `replySubject` 只加一次 `Re: `。
- 回复靠 **`messageId` 查找**（先查自己的收件箱、再查项目收件箱）关联到请求，**不是共享 thread id**。
- `threadId` 仅作为 `agents_read_inbox` 的**读取过滤器**存在。
- 每次对话的上限按 **"同一对代理 + 同一 subject"** 计数，不是按 thread id。

### 4.3 checkpoint：对话预算触顶时的持久交接

这不是上下文压缩，而是**对话持久化交接**。常量（`agentMailCheckpointMcp.cjs`）：
`MAX_EXCHANGE_MESSAGES = 12`、`CHECKPOINT_AT = 10`、`MAX_CHECKPOINT_FIELD_CHARS = 1500`。

`checkpoint` 的五个字段：`state`、`nextAction`（**必填**），`decisions`、`evidence`、
`blockers`（可选）。**从第 10 条消息起强制**："第 10 条起 sends 若无 checkpoint 则被拒绝。"

它被**存在邮箱里**、**追加到关联的 backlog 单据**上（`apiPatchTask(descriptionAppend)`，
尽力而为）、并在对话触顶时**交还**——"接手的人从它开始，而不是从零开始"。
结果里会带回 `conversation {count, ceiling, remaining}`、`checkpointId`、
`checkpointTicket` 与一句 `budgetNote`；当剩余 ≤1 时，提示"现在就用 checkpoint 和单据交接吧"。

**我复核到的边界**：这些文件里**没有任何代码路径**让邮件 checkpoint 触发重启或压缩；
它与重启只在**约定层面**耦合（`agentRestartMcpTool.cjs` 把场景描述为"某个上下文检查点/交接
例程保存了状态"，而那正是 `agents_restart` 自动化的东西）。强制逻辑位于
`electron/agentMail/exchangeCheckpoint.ts`，**不在本包内，未验证**。

### 4.4 发送预算（与团队同源但上限更高）

`MAX_SUBJECT_CHARS 200`、`MAX_BODY_CHARS 8000`、`MAX_RECIPIENTS 20`、
`MAX_INBOX_BODY_CHARS 24000`（超出部分**保持未读**并在下次返回，报为 `withheld`）、
`MAX_SENDS_PER_WINDOW 12`、`MAX_FANOUT_PER_WINDOW 30`、`SEND_WINDOW_MINUTES 10`
（用户标记的协调者获得**提高的预算**）。拒绝即"停止协调并向用户报告"，
**不是重试、改写、拆成单发、或交给新 spawn 的代理**。

### 4.5 项目收件箱与跨项目

- `to: "inbox"` 是**共享项目邮箱**（独占 `accepted` 认领；`outcome` 为
  `waiting|taken|declined|answered` + `handledBy`）。
- `project` 参数可给**账号下兄弟项目**的代理发信（同一套预算、暂停与上限；
  `to` 只能给 id，不能用 `"*"`；**回复回到你自己的收件箱**）。
- 桌面端会拒绝一个**未在本机打开**的项目，因为"邮箱住在 checkout 里"。

---

## 5. 人机闭环（HITL）

### 5.1 本仓库实际在场的证据

**`.agentsroom/handoff-transcript-agent-1791428387361-3bhiki.txt`**（真实交接记录）显示：

```
You are about to be replaced by another AI agent. Write a detailed handoff summary to the file
.agentsroom/handoff-summary-agent-1791428387361-3bhiki.md.
  Include the following sections: Current Task / Completed Work / Remaining Work /
  Key Decisions / Gotchas
  Be concise but complete. Write ONLY to ...: do NOT modify any other files.
```

随后是 `API Error: 403 ... Cloudflare error 1034 / Edge IP Restricted ... Do not retry`，
然后 `⏺ Crunched for 2s · done 11:01AM`。

**关键观察**：这次交接是**失效的**——要求的 `handoff-summary-agent-1791428387361-3bhiki.md`
**在此仓库中不存在**（我已确认 `Get-ChildItem .agentsroom -Filter 'handoff-summary*'` 为空），
`.agentsroom/sessions/` 与 `.agentsroom/team-runs/` 也**都不存在**。也就是说：
交接指令发出后，代理因上游 403 未能产出交接文件；**该交接没有落地**。[静态证据]

`.agentsroom/agent-mail/runtime.json` 显示该代理运行态：

```json
{ "projectPath": "D:\\aidev\\aistudio\\aistudio",
  "savedAgentId": "agent-1791428387361-3bhiki", "runtimeId": "pty-2",
  "runtimeGeneration": 3, "provider": "antigravity", "model": "default",
  "ptyId": "pty-2", "projectId": "proj-1791428385829-nje9yo",
  "status": "idle", "startedAt": 1791429859371, "heartbeatAt": 1791430088970 }
```

注意 `runtimeGeneration: 3` 与 `generations: { "agent-...": 3 }`——**这里确实有一个世代计数器**，
它存在于**桌面的运行时记录**里，而不在 REA 分析的那几个 `.cjs` 里（后者的身份是稳定
`agentId`，会话身份是 `sessionId`）。这是一处**必须区分**的点，见 §7.2。

### 5.2 Session file：用户看到的状态面

`sessionFileMcpTool.cjs` 写**调用者自己的** `.agentsroom/sessions/<agentId>.json`
（只允许恰好这个路径）。必填四字段：`notification`、`title`、
`type`（`feature|bug|refactor|chore|docs|style|perf|test|security`）、`needsInput`；
外加 `date`。合并 + 原子写（temp+rename，Windows 有回退）。

其存在理由（原文）：**只读的团队/QA 步骤会被扣掉写文件工具**，所以由 MCP server 代写
——"这个文件是应用的管线，不是项目的代码"。

`needsInput` 被本仓库的 boot prompt 描述为"规范的'代理正在等你'信号——桌面应用用它触发手机
推送、把该代理的卡片点亮为红色、并在'需要输入'收件箱里浮现该代理"，并且警告：
"一个多余的 TRUE 会白白唤醒用户，一个漏掉的 TRUE 意味着他们不知道你卡住了。"[静态证据]

### 5.3 `notify_user`：主动触达

身份**永远是调用者**；桥操作 `notify:user`；`MAX_NOTIFY_MESSAGE_LENGTH = 300`；
频率 **1 次/分钟**；等级 `all|needs-you|off`；结果是 `phone: 'sent'|'skipped'` 加
`reason: agent-muted|user-at-desktop|…`。定位明确：只在**无人值守**运行中遇到只有人能解的
事时使用**一次**，"从不用于进度或'完成'（回合结束通知已覆盖）"。

### 5.4 本仓库的实测配置

`~/.agentsroom/settings.json` 中与协作直接相关的键（[静态证据]）：

| 键 | 值 | 含义 |
|---|---|---|
| `interAgentMessaging` | `true` | 代理间通信开启 |
| `agentMailWakesRecipients` | `false` | **通知不唤醒收件人**（只写进空闲控制台） |
| `askBeforeAgentSpawn` | `true` | 代理发起的 spawn 需用户确认 |
| `maxLiveThrowawayAgents` | `8` | 临时代理上限 |
| `agentCommitMessage` | `true` | 提交信息由代理提供 |
| `agentPhoneNotifications` | `"all"` | 手机推送全开 |
| `agentPermissionMode` | `{omp:autonomous, antigravity:autonomous, claude:autonomous}` | 三个 CLI 均为自主模式 |
| `agentConnectionWrites` | `true` | 代理可自行写连接配置 |
| `quotaRules` / `quotaWarmup` | `null` / `{entries:[]}` | **未配置配额规则** |

`.agentsroom/agents-local.json` 为 `[]`（**本项目当前没有任何已保存代理**），
`.agentsroom/commands-cache.json` 只有一个空 `Terminal` 命令，
`skills-cache.json` / `prompts-cache.json` / `scheduled-tasks-cache.json` 全空，
`memory/INDEX.md` 明确写着 *"The project memory is empty."*（虽然 `memory-cache.json`
已预置了 `global` / `features` / `architecture` / `conventions` / `pitfalls` 五个文件夹，
即**文件夹结构在空项目上也已就绪**）。

---

## 6. 本仓库（AI Studio）作为被协作对象的实际状态

### 6.1 项目身份与基线

`.agentsroom/project.json`（[静态证据]）：

```json
{ "projectId": "proj-1791428385829-nje9yo",
  "backlogId": "proj-1791428385829-nje9yo",
  "repoIdentity": { "origin": "github.com/gentlescumfy/aistudio",
                    "rootCommit": "5fa5999b194b6e02ea47159f76fe604eaf478fc3" } }
```

我验证过：`rootCommit` 是一个真实存在的 commit，且 `git log 5fa5999..HEAD` 恰好是两步
（`4b01c61`、`608f794`）。这正是 `team_read_diff` 使用的**run 起点基线**语义。

### 6.2 自研层的接口面

`apps/api`（Fastify + TypeScript）与 `apps/web`（React + Vite）是**业务面**，
与 AgentsRoom 的协作机制**没有代码级耦合**。唯一的接口是：

- `.mcp.json` — AgentsRoom 写入的 MCP 接线，注册 `AgentsRoom-MCP`、
  `AgentsRoom-Test-Runner`、`AgentsRoom-QA-Tester` 三个 server；
- `.agents/`、`.claude/` — 其他 CLI 的等价接线；
- `.agentsroom/` — 运行态数据面。

`_etiquette.md` 对此有明文约束：*"`.agentsroom/` 是应用自己的管线，不是项目源码……你在里面
唯一会写的文件是你的 boot prompt 指名的那一个（session file）；其他一律走 MCP 工具。"*
并警告 *"代理开始修理喂给它上下文的基础设施，就是让项目上所有人一起坏掉的代理"*。[静态证据]

### 6.3 `project-scoped-refactor-plan.md` 的落地状态（重要）

我逐条核对了 `docs/project-scoped-refactor-plan.md` 的改造项，结论是**一项都未落地**：

> **基线时效**：下表核验于 commit `608f794`（第二轮）。**第四轮（本报告更新时）发现工作区已出现
> 方案 A 的未提交实现**：新增 `apps/api/src/projects.ts`（项目 id 校验 + 按项目分目录 +
> `langflowProjectId` 字段）与 `store-pool.ts`（每项目一整套 StoreSet，注释与原计划 §2.2
> "分目录天然获得每项目独立锁"逐字呼应），`app.ts` 194 行改动、`langflow.ts` +19 行——
> 均为**未提交、未验证**的进行中工作，下表"未做"的结论仅对 commit 历史成立。

| 计划项 | 实际状态 | 证据 |
|---|---|---|
| 移除媒体赛道硬编码（`IMAGE_REQUIRED`） | **未做** | `workflows.ts` 仍强制 `IMAGE_PROMPT_PARENT`；出边白名单仍写死 prompt/image/export 四种组合 |
| 引入 `projectId` + 按项目分目录 | **未做** | `app.ts:49-63` 六个 store 全部直接 `open(options.dataDir)`，无 projectId；`server.ts` 只有单一 `DATA_DIR` |
| 新增 `projects.json` | **未做** | 无此文件 |
| Langflow 改异步 `build/{flow_id}/flow` | **未做** | |
| 治理网关 | **未做** | 见下 |
| `lfx[sandbox]` / `lfx[toolguard]` | **未启用** | `services/langflow/pyproject.toml` 仅 `langflow-base==1.12.5` |

关于计划中特别点名的"已知缺口：`maxSteps`/`maxToolCalls`/`maxCost` 在 `roles.ts` 声明但
代码中从未读取"——**我独立复核后确认该缺口依然存在，但需要一条精确修正**：

- `deadlineMs` **确实被强制执行**：`agent-runtime.ts:18` 用它构造
  `AbortSignal.timeout(target.deadlineMs)`，且在 `engine.ts:269` 由
  `resolveAgentTarget(role.modelSelection, role.limits.deadlineMs)` 传入。
- `maxSteps` / `maxToolCalls` / `maxCost` **只出现在 schema 声明、前端表单与校验、
  以及只读展示里**（`workflow-contract.ts:38`、`apps/web/src/api.ts:31-35`、
  `roleUtils.ts:57-61`、`RoleLibraryPage.tsx:261-282`），**在 `apps/api/src/engine.ts`
  与 `agent-runtime.ts` 里从未被读取**。

即：**角色的"执行上限"是声明性契约 + UI 展示，不是运行时约束**。这一点与计划书的判断一致，
但计划书写成"全部从未被读取"略宽——精确表述是"除 `deadlineMs` 外从未被读取"。

---

## 7. 两个方向的相互印证与矛盾

### 7.1 一致的结论（互为独立证据链）

| 结论 | AgentsRoom 侧证据 | AI Studio 侧证据 |
|---|---|---|
| 协作是"文件投递箱 + 轮询"，无回调 | `team-mcp-server.cjs:1168` 原文 *file drop-box, no channel back* | 无（业务面不参与） |
| 身份必须在重开后仍可解析 | `mcpOwnAgentId.cjs` 用 `pty-owners.json` 的 `rootPid→agentId` 做祖先链回退 | `agent-mail/runtime.json` 的 `runtimeId`/`ptyId`/`generation` 就是这套记录 |
| 上限必须对模型可见 | `COMPLETE_STEP_LIMITS` 同时进描述与错误 | — |
| 空的 `memory/INDEX.md` **不代表没有记忆** | `memoryMcpProjectWrite.cjs` 等一等公民的注释 | 该文件本身原文写明"空即镜像未写，请先用 `memory_list`" |

### 7.2 一处必须澄清的"矛盾"（世代号）

REA 侧报告的正确结论是：**在被分析的 `resources/*.cjs` 里不存在"generation"计数器**，
身份是稳定 `agentId`，会话身份是 `sessionId`（`agents_restart` = 新会话、
`agents_resume` = **请求**旧 `sessionId`）。

但从本仓库的 `.agentsroom/agent-mail/runtime.json` 可以看到
`runtimeGeneration: 3` 与 `generations: {...: 3}`。**两者不矛盾**：世代号存在于**桌面运行时
记录**（`electron/agentMail/runtime.ts` 一类）里，不在随包的 `.cjs` 里。这正说明
**"REA 没看到" ≠ "不存在"**——REA 只分析了 `resources/`，而 `app.asar` 内部的主进程代码
（110 MB）本轮未做深挖（缺原生引擎不影响这一步，但需要额外一轮 JS 分析）。

### 7.3 一处实质矛盾

| 面 | 说法 | 事实 |
|---|---|---|
| `_etiquette.md` / boot prompt | "绝不要写探测脚本，绝不要打开应用的 `.cjs` MCP server 去逆向其 schema" | **本次分析正是这么做的**（受用户明确指派，且只读、不修改） |

这不构成缺陷，但值得指出：**该禁忌对本分析不适用**（用户明确要求、纯只读、未写回任何
`.agentsroom/` 文件），而对一个自主运行的代理仍然适用——那条规则保护的是运行态数据面，
不是"永远不许读"。我在本次执行中遵守了它的实质：**只读，未修改仓库外任何文件**。

---

## 8. 局限与未验证项（诚实清单）

**REA 侧**

1. **本机无原生分析引擎**（Hopper/Ghidra/IDA 全部缺失），原生二进制路径未使用。
2. **REA 无法回答协作协议问题**：工具名录、协作动词、状态枚举、数值上限在 REA 输出中
   **零证据**（已在 400 MB 全量输出上独立复核）。REA 的价值集中在整包 Electron 边界、
   IPC 面、以及单文件常量/名字面量。
3. **REA 不证明运行时行为**，其自述局限已逐条引用。所有协议语义均为**静态推断**，
   我**没有启动任何 MCP 会话**去实测。
4. `sender_validation_observations: 30` 只是**观察**，REA 明确不主张这构成完整授权策略。

**AgentsRoom 侧（未验证的关键部分）**

5. ~~邮箱存储与队列实现~~ → **第二轮已解决**（见 §11）。
6. ~~运行器（`teamRunner.ts` / `teamRunSignalSweep.ts` / `teamMessageRouter.ts`）~~ →
   **第二轮已解决**（见 §11）；`teamMessageRouter` 的渲染进程投递路径已定位，
   但 PTY 写入函数体本身仍未逐行读取（§11.4 明确标注）。
7. `agents_resume` 的回执本身坦白：`continuationProven: false`、
   `observedSessionId: null`、`status: 'resume_requested'` —— **"启动被接受"不等于"CLI 真的
   续上了那条线程"**。这是一个**由设计者主动承认**的能力边界。**第二轮已确认桌面侧从不校验它**
   （见 §11.8）。


**本仓库侧**

8. `.agentsroom/memory/` 为空，因此**无法**从记忆面验证协作假设。
9. `handoff-transcript` 显示的上一次交接**未能产出** summary 文件（见 §5.1），
   所以这次交接的**实际效果无法验证**。
10. 我未运行 `npm test` / `npm run build` / 端到端测试——本次任务是分析，不是改动，
    且 AI Studio 的三服务（API/Web/Langflow）当前未启动。

---

## 9. 可选改进建议（按性价比排序，均未实施）

### 9.1 对本仓库（AI Studio）

1. **先决策"要不要自建 Project 隔离"**。`project-scoped-refactor-plan.md` 的方案 A 要
   自己实现 `projects.json` + 按项目分目录 + 治理网关；而 AgentsRoom 已经通过
   `AR_PROJECT_ID`（稳定 git 提交 id）+ `.agentsroom/` 提供了**项目级隔离与代理编排**。
   两者是**同一层抽象的两个实现**。建议在动手前明确边界：
   - AI Studio 的 projectId 服务的是**业务数据的多租户隔离**（settings/roles/workflows/runs）；
   - AgentsRoom 的 projectId 服务的是**协作面隔离**（backlog/memory/agents/team-runs）。
   如果目标是后者，方案 A 的大部分工作是重复建设。
2. **最小可落地的两项**（`project-scoped-refactor-plan.md` 第 3 节排序的第 1、2 步）仍然值得做，
   因为它们不依赖任何外部决策：
   - 移除 `IMAGE_PROMPT_PARENT` / 收窄 `INVALID_EDGE_KIND` 的硬编码出边白名单，
     以解锁非媒体类 SOP（当前 `prompt→prompt`、`prompt→image`、`image→export`、
     `prompt→export` 四种组合写死，纯软件开发 SOP 会被误拒）；
   - `dataDir` 改为按项目分目录（`FileStore.writer.lock` 是
     `join(this.directory,'writer.lock')`，**分目录天然获得每项目独立锁**，迁移成本最低）。
3. **把 `maxSteps`/`maxToolCalls`/`maxCost` 的语义说清楚**：要么在 `engine.ts` 中真正强制
   （并在 UI 上标注"已强制"），要么把字段改名为 `declaredLimits` 并在文档中明确
   "当前仅 `deadlineMs` 生效"。现状是 UI 展示了四个上限、只有一个被执行，
   **对使用者是可误导的**。
4. `services/langflow/pyproject.toml` 需要在真正跑软件开发类 SOP 前显式启用
   `lfx[sandbox]` 与 `lfx[toolguard]`。

### 9.2 对协作实践（基于观察到的机制）

5. **本项目的 memory 是空的**——这是最便宜的高回报项。按 `_etiquette.md` 的规则，
   每次有"未来代理会真正再撞上"的结论时写一条 note（`features/<feature>` 或
   `global/architecture`），成本是一次 `memory_save`。
6. **`agentMailWakesRecipients: false` 值得留意**：通知只写进**空闲**控制台。
   结合 `interAgentMessaging: true`，一个忙着的代理在自己回合结束前不会看到邮件——
   这符合设计（"从不打断忙的 CLI"），但意味着**跨代理的实时协作实际上是有延迟的**。
7. **长任务用 session file 的 `needsInput`，而不是靠 `notify_user` 报进度**：
   `notify_user` 有 1 次/分钟限制且被明确指定"从不用于进度或完成"。
8. 任何需要**人类决策**的关口，用团队的 `await` 节点或 `flags.needsInput: true`，
   而不要试图用消息解决——`team_send` 在 `awaiting-user` 上"什么都推动不了"。

---

## 10. 附：证据索引

| 证据 | 位置 |
|---|---|
| REA 整包分析（400 MB md） | `$PI_SCRATCH_DIR\rea\agentsroom-analyze.md` |
| REA 单文件分析 md | `$PI_SCRATCH_DIR\rea\rea_*.cjs.md`、`rea\out\*.md` |
| REA 调用脚本 | 仓库根 `run-rea-direct.mjs`（本次分析用的辅助脚本，可直接删除） |
| 团队 MCP server | `%LOCALAPPDATA%\Programs\AgentsRoom\resources\team-mcp-server.cjs` |
| 团队契约（图/生命周期/停顿） | 同目录 `capabilitiesTeamsContract.cjs`、`teamRunLifecycleContract.cjs`、`teamRunStallGuide.cjs` |
| 团队护栏 | 同目录 `teamSendBudget.cjs`、`teamRouteCheck.cjs`、`teamPendingCompletion.cjs`、`teamRunFinalStep.cjs`、`teamReadDiff.cjs` |
| 团队存储 | 同目录 `teamRunStore.cjs`、`teamRunStoreWorker.cjs`、`mcpOwnAgentId.cjs` |
| Agent Mail | 同目录 `agentMailMcpTools.cjs`、`agentMailMcpHandlers.cjs`、`agentMailCheckpointMcp.cjs`、`agentMailMcpInbox.cjs`、`agentMailMcpText.cjs` |
| 代理持久化/重启 | 同目录 `agentSaveMcpTool.cjs`、`agentRestartMcpTool.cjs`、`agentResumeReceipt.cjs`、`sessionFileMcpTool.cjs`、`notifyUserMcpTool.cjs`、`agentConnectionScope.cjs` |
| 项目运行态 | `.agentsroom/project.json`、`agent-mail\runtime.json`、`agents-cache.json`、`memory\INDEX.md`、`handoff-transcript-*.txt` |
| 全局运行态 | `~\.agentsroom\settings.json`、`roles\*.md`、`roles\_etiquette.md` |
| 本次交接记录 | `.agentsroom/handoff-transcript-agent-1791428387361-3bhiki.txt` |
| 本仓库改造计划 | `docs/project-scoped-refactor-plan.md` |

### 第二轮证据索引（补）

| 证据 | 位置 |
|---|---|
| 解包后的 app.asar 全树（2,376 文件 / 104.5 MB） | `$PI_SCRATCH_DIR\asar\` |
| **美化后的主进程 bundle**（125,702 行 / 9 MB，本轮核心依据） | `$PI_SCRATCH_DIR\asarwork\main.pretty.js` |
| 原始 bundle（对照用） | `$PI_SCRATCH_DIR\asar\dist-electron\main.js` |
| 渲染进程投递链路 chunk | `asar\dist\assets\App-*.js`、`useTerminalReportColors-*.js` |
| Agent Mail 磁盘布局（真实存在） | `<project>\.agentsroom\agent-mail\{messages,events,checkpoints,exchange-resets}\` + `runtime.json` + `controls.json` |

---

## 11. 第二轮：解开 `app.asar` 后的运行器与 Agent Mail 实现

第一轮的三个"未验证"缺口，本轮通过解包 `app.asar` 并**美化**（prettier，`babel` 解析器）
主进程 bundle 后全部补齐。复现方式：`npx -y @electron/asar extract <app.asar> <dir>`，
再 `npx -y prettier@3 --parser babel main.js > main.pretty.js`。

**为什么这一轮可行而第一轮不行**：bundle 虽然**标识符被混淆**（`wn`/`S1`/`k_`/`oS`），
但**字符串字面量完整保留**，且包含第一轮完全看不到的运行器与邮箱实现。
这也再次印证第一轮的结论：**REA 看不到这些，不是引擎问题，是分析模型问题。**

### 11.1 权威状态枚举（推翻第一轮"只有客户端契约级证据"的说法）

编译产物 `main.pretty.js:118283-118285` 是权威定义：

```js
const cmt = ["pending","running","awaiting-handoff","awaiting-finalization","awaiting-user"],
      umt = ["done","cancelled","blocked"];
function lmt(e){ return cmt.includes(e) || !umt.includes(e); }   // "是否仍存活"
```

**这与第一轮从 `teamRunLifecycleContract.cjs` 抄录的 7 个状态完全一致** ——
即那份契约不是宣传文案，而是与实际执行相符。`blocked` 的实际写入点有三处：节点超循环
（95340）、扇出超循环（95478）、**隔离检出无法供给**（95269，契约里没有这一条）。

### 11.2 路由与循环护栏（实测确认，并纠正一处契约误述）

**"最具体的条件边胜出"——实测确认**（95167-95171）：

```js
function ane(e,t){ let n=null; for(const r of e) bGe(r,t) && (!n||uW(r)>uW(n)) && (n=r); return n; }
function uW(e){ const t=F_(e); return t.length===0?0:e.conditionMode==="any"?1:t.length; }
```

得分 = 条件数（`any` 记 1 分），**平局取第一条**。一旦某条条件边命中，
**无条件边被完全忽略**（`k_` 返回 `ids:[i.to]`）；若无条件边命中，则**全部发射**（即扇出）。

**循环护栏**（95323-95341）：

```js
function bp(e){ return e.team.maxCycles + (e.run.cycleBonus ?? 0); }
const s = (e.run.cycleCount[t] ?? 0) + 1;
if (s > bp(e)) { e.run.cycleLimit={nodeId:t}; G_(e,"blocked",`Max cycles (${bp(e)}) reached on node ${t}.`,{destroyAgents:!1}); return; }
```

`cycleCount` 是 **per-node 计数**（`{nodeId: n}`）。⚠️ **实测纠正**：
契约说 `maxCycles` 默认 3（`capabilitiesTeamsContract.cjs:276`），但运行器里
**没有任何默认值** —— `bp` 直接读 `team.maxCycles`。若该字段缺失，
`undefined + 0 = NaN`，而 `s > NaN` **恒为 false** ⇒ **循环护栏被静默关闭**。
默认值必须在团队保存/RPC 阶段补齐，运行器不兜底。

`team_extend_run` 的桌面侧实现是 `FGe`（95317-95322），要求
`status==="blocked" && cycleLimit && 已授予 + 本次 <= agentExtraCyclesMax`，
授予时走 `run.cycleBonus += max(1, n)`。注意 bundle 里**不存在 `team_extend_run` 这个字符串**
——它是 MCP 侧名字，桌面侧是 `team-run:extend-*` / `team-run:reenter-node` IPC。

### 11.3 信号扫描：5 秒轮询、**不删除**、且刻意忽略重启前的信号

第一轮我推测"运行器读后删除信号文件"。**实测：不删除。**

```js
const Nte = 5e3, Mke = 2e3;                                   // 93301-93302
function iv(e){ return e.startsWith("step-complete") && e.endsWith(".json"); }   // 73501
setInterval(xGe, Nte);                                        // 95852
```

去重靠 **mtime 窗口**（`mtimeMs >= since - 2000`，`vke` 93303-93309）加状态守卫，
**不是靠删除文件**。另有一条 `fs.watch`（`Ote` 93339）触发去抖扫描（150 ms）。

**同时纠正第一轮的一个猜测**：并行分支的信号文件**不是** `step-complete-<agentId>.json`。
匹配器就是上面的 `iv`，它只认 `step-complete*` 前缀；
**节点/代理身份从文件内容读取**（`s2e` → `{runId, nodeId, stepStatus:"done"}`），
再按 `n.nodeId` 匹配到分支。没有 per-agent 的文件名编码。
（第一轮那句"并行分支为 `step-complete-<agentId>.json`"来自 MCP 侧注释，**注释与实现不符**。）

**重启重臂（boot re-arm）确认**（95822-95841）：

```js
function U1(e, t){ const r = t.rescan !== false; e.stepCompleteWatchSince = r ? 0 : Date.now(); ... }
```

`rescan:false` 使 `since = now`，于是**任何早于 now-2000ms 的 `step-complete` 文件都被忽略**。
重启路径只调用一次（`Aje` 96773-96775：run 处于 `awaiting-finalization` 且有 `finalStep` 时）。
这是**刻意**的：避免重启后重复消费已经处理过的终结信号。另外 `C7e`（96725）会**抑制
关停时正处于 `awaiting-input` / `agent-silent` 的步骤被重新进入**。

### 11.4 Agent Mail 的真实磁盘布局与限制强制点

**布局**（71253-71280，与第一轮的文档级描述一致，现已实测）：

```
<project>/.agentsroom/agent-mail/
    messages/<msg-id>.json        一条消息一个文件
    events/<evt-id>.json          一次状态变迁一个文件
    checkpoints/<id>.json         对话检查点
    exchange-resets/<id>.json     对话计数重置
    runtime.json                  运行时注册表
    controls.json                 { pausedSenders: {agentId: ts} }
```

ID 形如 `msg-<base36 时间戳 9 位补零>-<4 hex>`，**因此文件名按时间字典序即时间序**。
单次列表最多取 500 个文件（`xa=500`）。写入经**temp + fsync + rename**（`dn` 12716-12740）。

**真实限制值**（71185-71205，实测）：

| 常量 | 值 | 含义 |
|---|---|---|
| `NIe` / `OIe` | 200 / 8000 | subject / body 上限 |
| `bG` | 20 | 单次收件人上限 |
| `bIe` | 24000 | 单次收件箱读取的正文上限 |
| `iJ` | 10 min | 发送窗口 |
| `sJ` / `oJ` | **12 / 30** | 每窗口发送数 / 扇出数 |
| `DIe` / `MIe` | **36 / 90** | **协调者**的加高额度 |
| `Yo` | 12 | 单对话消息上限 |
| `Ug` | `ceil(12*0.8)` = **10** | checkpoint 起始条数 |
| `BIe` | 1 h | 重复发送守卫窗口 |

**这与第一轮从 MCP 描述抄录的 12/30/10min 完全吻合** —— 文档没有撒谎。
但**协调者额度 36/90 在文档里只写"a raised budget"，从不给数字**（现已补上）。

**强制点**在 `tCe`（72218-72261），位于 `agentmail:send` 桥操作背后，
**在消息文件写入之前**逐条按序拒绝：全局开关 → 发送者被暂停 → **1 小时重复守卫** →
**单对话上限** → **线程上限** → **checkpoint 必需** → 发送预算 → 扇出预算。

**对话键**（72034-72064）实测为 **`sort(from,to).join("|") + "#" + 归一化 subject`**，
其中归一化 = 转小写 + 去 `re:` + 折叠空白。**不是 thread id** ——
这正好解释了文档那句"用新消息而非 reply 回复并不能重置它"。

**checkpoint 的强制点**是 `qwe`（72132-72145）：对每个收件人 `r = count+1`，
若 `r >= 10` 且该对话无 checkpoint ⇒ **抛错，什么都不发送**；必填字段 `state` + `nextAction`。

### 11.5 投递模型实测：主进程只落盘，**渲染进程写 PTY**

第一轮我推断"先持久化后投递、只写空闲控制台"。**实测确认，且定位到了具体分工**：

**主进程不写 PTY。** 它落盘、发 `agent-mail:changed` 事件、暴露 `agent-mail:pending`。
真正的 PTY 写入在**渲染进程** chunk（`App-*.js` 的 `i_` 函数）：

```js
const a = Al(e, o);              // 仅当收件人有活跃/就绪控制台才返回 writer
if (!a) { s_(e, o); return; }    // 否则走唤醒路径
await rr(a, cy(t, n, a_(t,e), i, Il(e,o)));   // ← 唯一写 PTY 的地方
await window.electronAPI.agentMailMarkDelivery({...r, ok:true});
```

**"从不打断忙的代理"确认成立**：只有 `Al` 返回活跃控制台时才写；
忙的代理其条目**就停在 `queued`**，不会中途注入。
空闲/忙**编码在通知文本里而非分支拦截**（"控制台空闲时…这就是你眼前下一件事" vs
"它等在项目收件箱里…先做完手上的才是对的"）。

**`agentMailWakesRecipients` 的实测语义**：它是**渲染进程侧**开关
（`ZO() = interAgentMessaging && agentMailWakesRecipients`）。为 `true` 时，
`s_` 会**自动拉起离线收件人的控制台**以便投递；为 `false` 时离线者只能等下次启动。
本仓库该值为 **`false`**，所以第一轮那条观察（"跨代理实时协作实际有延迟"）**成立且原因已明确**。

### 11.6 两处值得记录的实现细节

**项目收件箱的独占认领不是原子的。** `J3`（71652-71659）在「已有决定且行动者不同」时抛错，
但状态存在**append-only 的事件文件**里，认领是 **read-then-write**：
两个代理同时读到 `waiting` 并各自 ack，**可能都写入 `accepted`**。
进程内单线程使窗口很窄（需分属不同 IPC 轮次），但**没有锁/CAS**。
（子代理明确标注为"未找到证据 ≠ 证明不存在"，我沿用这一措辞。）

**`coordinationPaused` 同时阻断发送与投递**：`tCe` 在发送者被暂停时抛错，
且 `uCe` 会把被暂停发送者的邮件**从可投递列表中过滤掉**。
这与全局 `interAgentMessaging` 开关（阻断所有人）**不是一回事**。

### 11.7 一枚必须点名的"幽灵停顿原因"

契约与停顿指南都描述了 7 个 stall reason。实测在**整个主进程 bundle** 中：

| reason | 出现次数 | 是否有写入者 |
|---|---|---|
| `no-spawn-ack` | 1 | ✅ `hGe` 定时器（94756） |
| `delivery-failed` | 1 | ✅ `EGe`（94785） |
| `awaiting-input` | 1 | ✅ `_Ge`（94794） |
| `reply-missing` | 4 | ✅ `mGe`（94817） |
| `no-route` | 1 | ✅ `Il`（96402） |
| **`console-missing`** | **0** | ❌ **整个 bundle 零次出现** |
| **`agent-silent`** | 1 | ⚠️ **仅出现在读取集合 `w7e`（93813），无写入者** |

`console-missing` 在美化的 bundle、**原始 bundle、以及 `electron\*.cjs` 中均为 0 次**；
它只作为契约文案与渲染进程 i18n key（`timeline.stalledConsoleMissing`）存在。
`agent-silent` 同理，只在 `w7e` 里被**消费**。

**含义**：这两个停顿原因在当前版本的桌面端**永远不会被产生**——
要么是历史遗留，要么由移动端/其他版本写入。
对使用者的实际影响：**你不可能在桌面端看到 `agent-silent` 或 `console-missing` 的停顿提示**，
尽管文档把它们描述成一等公民。这是第一轮纯读契约**必然误判**的一处。

### 11.8 `agents_resume` 的能力边界：桌面侧从不校验

第一轮记录了回执里的 `continuationProven: false`。本轮补上关键的一半：
在整个解包树（2,376 个文件）中，**`continuationProven` 只出现在
`electron/agentResumeReceipt.cjs` 一个文件里** —— 即**只在 MCP 侧回执中被声明**，
**桌面端没有任何代码去校验或提升这个事实**。

这不是缺陷（设计者选择如实回报而非假装成功），但它意味着：
**"resume 成功"这个判断永远不能由工具返回值推断**，只能由用户或后续输出来确认。

---

## 12. 第三轮：模型切换时的上下文交接机制（"总结上下文"）

用户问"代理切换模型时上下文是怎么总结的"。机制完全在**渲染进程**里
（`asar\dist\assets\main-aJ7qfTYK.js` 的提示词模板 + `useUiZoom-EqZjYQwe.js` 的切换分发器），
主进程只记录团队时间线事件（`model-switched`，`team-run:record-model-switch` IPC，
`main.pretty.js:94828/103069`）。

### 12.1 先分岔：原地切换 vs 重启交接

分发器 `jh`（useUiZoom 2816269）的第一条路是**零交接**：

> 同一 provider、只换 model、且该 provider 声明了 `buildModelSwitchCommand` 时，
> 直接把 CLI 自己的切换命令写进 PTY（`/model <id>`），更新 launched-config，**结束**。

声明了 `buildModelSwitchCommand`（即支持 `/model` 原地切）的 provider 实测有 7 个：
**claude、copilot、grok、mistral、kimi、omp、devin**（main-aJ7qfTYK.js 141282-154563），
全部带 `compactCommand:"/compact"`。**codex、antigravity、cursor、opencode、aider 没有**——
它们换模型必须走重启交接路径。

同 provider 内"活切"连模型建议弹窗都直接写 `/model`（2382721），同样零交接。

### 12.2 重启交接的三层数据源（`Oy`/`Nxe` 模板，main-aJ7qfTYK.js）

需要重启 PTY 时（换 provider、或换 CLI 实现），旧 PTY 被 `killPTY`，
新控制台的第一条消息由 `Oy` 生成，**三层降级**：

| 层 | 数据 | 新代理收到的提示（原文要点） |
|---|---|---|
| **T1 详细总结** | `detailedSummary` | "You are continuing work previously started by {Provider (Model)}. Pick up exactly where it left off. Do NOT redo work… 下面是前一个代理写的详细交接总结：{全文} … Read the summary above carefully, then ask the user what to do next." |
| **T2 原始转录** | `rawTranscriptPath` | "Its full terminal transcript has been saved to `{.agentsroom/handoff-transcript-<id>.txt}`. Read that file to understand what was done… Then pick up exactly where it left off… ask the user what to do next." |
| **T3 基础上下文** | 会话元数据 | fromProvider/fromModel + "Files already modified in this session:（最多 30 个）" + "Last activity: {summary}" + "Last message from the previous agent: {≤500 字符}" + "Ask the user what to do next." |

### 12.3 T1 的产生方式：**让出站的代理自己写总结文件，宿主轮询读盘**

`osn`（useUiZoom，完整逻辑）：

1. 先**删除**旧的 `.agentsroom/handoff-summary-<agentId>.md`（防旧文件误用）；
2. 把 `Ay` 提示词写进出站代理的 PTY——即第一轮在
   `handoff-transcript-*.txt` 里看到的那段：*"You are about to be replaced by another AI agent.
   Write a detailed handoff summary to the file `.agentsroom/handoff-summary-<id>.md`，
   含 Current Task / Completed Work / Remaining Work / Key Decisions / Gotchas 五节，
   Write ONLY to that file"*；
3. 宿主进入 `summarizing` 阶段（UI 显示 "Switching to X (M) with context summary…"），
   **每 `ECe` 毫秒轮询读那个 .md**：
   - 文件存在且 >20 字符 → 成功，取 `{summary: 全文}`；
   - 观察到出站代理 `thinking/needs_input` 后回合结束（`done`）但没写文件 → `no-summary`；
   - PTY 消失 → `pty-gone`；总时长到顶 → `timeout`；
4. 成功：T1 交接，且**用完即删**该 .md；失败：**降级 T2**（此刻抓 PTY 全文转录写
   `.agentsroom/handoff-transcript-<agentId>.txt`，"Falling back to the raw terminal
   transcript."），再不行才 **T3**（"Falling back to basic context: modified files and
   last activity."）。

失败文案全在 locale 里：`summarizeFailed.unreachable` = "The previous agent could not be
reached, so it wrote no handoff summary."，`pty-gone` = "The previous agent stopped before
writing its handoff summary…"。

### 12.4 本仓库那笔 403 交接 = 这条链路的真实样本

第一轮的 `handoff-transcript-agent-1791428387361-3bhiki.txt` 现在可以完整解释：
转录里出现了 `Ay` 提示词（"You are about to be replaced…"）→ 出站代理（Claude Code）
收到指令后立刻撞上 Cloudflare 403（Edge IP Restricted）→ **没能写出 .md** →
命中 `no-summary`/`timeout` → 宿主降级 T2 落盘转录文件。
磁盘现状（有 transcript、无 summary、无 sessions/team-runs）**与机制预测完全一致**，
是这条降级链路的实物证据。

### 12.5 与既有机制的对照

- **和 `agents_restart` 的区别**：`agents_restart` 的提示词是用户/例程自写的"自包含简报"
  （无数据层自动注入）；模型切换的 T1-T3 是**宿主自动装配**的。
- **和 Agent Mail checkpoint 的区别**：mail checkpoint 是**跨代理**对话预算触顶时的持久交接
  （写进邮箱 + backlog 单据）；这里是**同一代理换模型**的会话内交接（写进 `.agentsroom/`）。
- **团队运行中的切换**：只额外记一条 `model-switched` 时间线事件（含 nodeId/agentId/cycle），
  交接机制本身不变。
- **未被本轮覆盖**：`modelEquivalenceRef`、`adaptiveModelEnabled` 两个 settings 键在 bundle 里
  有消费（main-aJ7qfTYK.js 8 处、useUiZoom 21 处），但其语义（等价模型映射 / 自动换模型）
  未逐行验证，不在本节结论范围内。

---

## 13. 整体架构（第四轮：把前三轮拼成一张图）

以下所有结论均有前三轮证据支撑，证据位置在表中标出；本轮新增证据来自
`package.json`、`preload.js`、`resources\{hooks,opencode,omp,pyconnectors,node_modules}\`
与云端 API 面的 grep。

### 13.1 自我描述与进程拓扑

`package.json`（asar 根）自述为 **"Multi-agent Claude terminal manager"**，
`main: dist-electron/main.js`，可选依赖仅 `node-pty` + `appdmg`。
自动更新走 `https://agentsroom.dev/downloads`（`app-update.yml`，generic provider）。

```
  [agentsroom.dev 云端]
   backlog / memory / 全局库 / user-teams / obsidian-sync / 移动端中继 / 更新包
        │ HTTPS（MCP sidecar 经 AR_API_BASE_URL；主进程 13 个 /api 路径）
  [手机 App] ⇄ relayWsUrl / pairing（主进程 7/7 处标记，wss:// 5 处）
        │
  [Electron 桌面端]
   ├─ main 进程（dist-electron/main.js，3.4 MB bundle）
   │    · 团队运行器：内存 wn Map + 每 run 的 state.json / timeline.jsonl / inbox/
   │      （§11.1–11.3）
   │    · Agent Mail 存储：.agentsroom/agent-mail/（§11.4）
   │    · 423 个 ipcRenderer.invoke 面 + 164 个 on 面（preload.js 实测）
   │    · team-run:* / agentmail:* / mobile-pairing IPC 家族
   ├─ 渲染进程（dist/assets，React；useUiZoom 单块 51 MB）
   │    · UI 组织视图；邮件的 PTY 投递执行者（§11.5）；模型切换分发器（§12）
   ├─ preload.js：两个暴露面 electronAPI / bridgeAPI
   └─ 外部子进程
        · N 个 PTY 代理控制台（Claude Code、Codex、Gemini、Cursor、Grok、
          Kimi、OMP、Devin、Copilot、aider、opencode…15+ CLI）
          每个 CLI 侧挂 stdio MCP sidecar（resources/*.cjs，零依赖 CJS，
          "runs on the USER's node, not Electron's"）：
          app-mcp-server（主工具箱）/ team-mcp-server（run 内 10 工具）/
          browser-mcp / test-runner-mcp / qa-tester-mcp
        · Python hooks：team-reminder.py（Claude UserPromptSubmit，
          每回合重注入团队上下文、抗上下文压缩）、notify-agentsroom.py
        · 远程（SSH 宿主）：pty-helper.py 真 PTY 代理 +
          AGENTSROOM_TEAM_BRIDGE_FILE → 桌面桥（§11.3 远端 run 状态）
        · 远程机器：pyconnectors/（WinRM / Kerberos / SMB / PS 管道）
          + elevate.exe（Windows 提权）
```

### 13.2 与 15+ 种 CLI 的集成方式（不是 fork，是接线）

桌面端对每个 CLI 的写入物分四类（`_etiquette.md` 列了全部 13 个 per-provider
配置写入器）：

| 类别 | 实例 | 作用 |
|---|---|---|
| MCP 配置 | `.mcp.json`(Claude/Copilot)、`.agents/`(Gemini/Antigravity)、`.grok/config.toml`、`.vibe/`(Mistral)、`.kimi-code/`、`.amp/`、`.omp/`、`.devin/`、`.cursor/` | 注册 5 个 sidecar |
| 提示词 | `~/.agentsroom/agent-prompts/<id>-boot.md`（boot prompt，§5） | 角色 + 工具礼仪 + session file 约定 |
| 原生插件 | `resources/opencode/`（plugin+status+turns+usage）、`resources/omp/`（extension） | 这两个 CLI 不走 MCP，走自家插件 API |
| 钩子 | `resources/hooks/team-reminder.py`（Claude 的 UserPromptSubmit） | 团队上下文每回合重注入 |

同一能力按 CLI 能力降级：`/model` 活切（§12.1 的 7 家）有则用；
`readOnly` 步骤"在 claude/codex/grok/antigravity/opencode 上 CLI 级强制，
其余仅提示词级"（团队契约原文）。**架构选择：桌面端是编排者，代理是外置的、
可替换的 CLI 子进程**——这是整个系统最重要的一条设计决策。

### 13.3 数据面：三个域，写入方向各不相同

| 域 | 位置 | 内容 | 写路径 |
|---|---|---|---|
| **项目域** | `<project>/.agentsroom/` | 缓存（backlog/prompts/skills/commands/memory）、`memory/` 镜像、`team-runs/<id>/`、`sessions/`、`agent-mail/`、`handoff-*` | 桌面端重写；**代理唯一可写的是自己的 session file**（`_etiquette.md` 铁律） |
| **全局域** | `~/.agentsroom/` | `settings.json`、`roles/*.md`、`agent-prompts/`、`pty-owners.json`、`browser-bridge.json`、relay/pairing 凭证 | 桌面端独占 |
| **云端域** | `agentsroom.dev` | backlog/ideas/全局库/项目记忆/用户团队/obsidian 同步 | 桌面端与 MCP sidecar 双路；backlog/memory/库**云优先**（应用关闭仍可用），Agent Mail **本地优先**（收件人在这台机器上） |

两个刻意的取舍（均有源码注释佐证）：

- Mail 本地 vs backlog 云端："a mailbox is local by nature: the recipients are
  consoles on this machine… That is the opposite trade-off from the backlog/memory
  families, which are cloud-first so they work with the app closed"。
- 双源常量："Mirrors `src/shared/agentMailPolicy.ts`. Duplicated on purpose,
  like agentMailMcpTools.cjs does: this file cannot import TypeScript."
  —— 零依赖 sidecar 与主进程的共享代码只能**逐字复制**，一致性靠同 commit 人工保证。

### 13.4 通信矩阵（谁 ↔ 谁，走什么）

| 通道 | 载体 | 语义 |
|---|---|---|
| 代理 → 桌面 | PTY 输出解析（`detectBusy/detectNeedsInput/detectLiveBackgroundWork` 每 CLI 一套） | 状态推导 |
| 桌面 → 代理 | PTY 写入（brief、`/model`、邮件通知、hook 提醒） | 单向注入，**从不打断回合** |
| 代理 ↔ 桌面（结构化） | 5 个 stdio MCP sidecar | 工具调用；`callerAgentId` 由 env 盖章、**不接受参数伪造** |
| 代理 ↔ 代理（跨 CLI） | Agent Mail（`.agentsroom/agent-mail/`，持久先投递后） | 组织内通信，预算护栏（§4/§11.4） |
| 代理 ↔ 代理（run 内） | team-mcp-server（signal 文件 + inbox 文件 + NOTES.md，§3/§11） | 图流水线；文件 drop-box，**无回调** |
| 桌面 ↔ 手机 | relay/pairing（wss）+ 推送 | 远端监控/回答 `awaiting-user`/手机控制台 |
| 桌面 ↔ 云端 | HTTPS `/api/*`（主进程 13 路 + sidecar 12 路） | 共享工件同步 |
| 桌面 ↔ SSH 宿主 | `AGENTSROOM_TEAM_BRIDGE_FILE` 桥 + `pty-helper.py` | 远程代理控制台，run 状态仍在桌面端 |
| 代理 ↔ 远程机器 | `ssh_*` 工具 → pyconnectors（WinRM 默认只读） | 用户的机器清单 |

### 13.5 安全模型（散点汇总，均已实测）

1. **身份不可伪造**：`callerAgentId` 只来自 `AGENTSROOM_AGENT_ID` 环境变量；
   环境变量丢失时走 `pty-owners.json`（`rootPid→agentId`）祖先链回退（§5/§7.2）。
2. **密钥不落地**：UI 只接受 `{{secret:NAME}}` 引用；值由桌面端在**创建 PTY 时**
   注入进程环境；密钥值永不进对话、文件、命令参数（`_etiquette.md` + boot prompt）。
3. **写隔离**：团队节点 `readOnly`（判断型角色）与 `ownWorktree`（可写/可测分支），
   扇出共享树告警 `fanout.sharedTree`（§3.6/§11.2）。
4. **IPC 面**：REA 只观察到 30 处 sender 校验（明确不证明完整授权策略）；
   未配对的 15 个 renderer channel 仍应视为**待审计项**（§2）。
5. **失败即封闭**：worktree 解析失败 → 票据退回 todo（`start_refused`）；
   锁恢复失败 → 要求人工检查；存储故障 → 503 而非半写。

### 13.6 架构特征（从逆向中读出的设计哲学）

- **编排与执行分离**：桌面端拥有"编排真相"（run 状态、邮件队列、账本），
  代理只有"执行权"。所有跨代理事实都落在**磁盘文件**上，任何一侧崩溃后可重建。
- **对模型可见的护栏**：每个上限同时写进工具描述与拒绝文案，且拒绝句以
  "该做什么"结尾而非"该重试"（§3.5）。这是**为 LLM 读者设计的 API 文档**。
- **零依赖 sidecar**：`resources/*.cjs` 全部 ES5 友好、无依赖、随包分发，
  在用户的 Node 上跑——代价是 §13.3 的双源常量复制。
- **可逆性优先**：会话文件只写不删（除用完的 handoff summary）、邮件 append-only
  事件流、取消 ≠ 完成（`team_cancel_run` 不动票据）、记忆 upsert 不删除。
- **混淆 bundle 但保留字面量**：标识符混淆、字符串完整——
  这使得三轮逆向（§11/§12）无需符号表即可进行；副作用是任何字符串都能被
  静态检索到，**契约文案即攻击面**（文档与实现漂移时，如 §11.7，被检索到的就是旧文案）。

