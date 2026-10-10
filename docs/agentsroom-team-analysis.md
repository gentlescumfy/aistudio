# AgentsRoom「团队（Team）」完整机制报告（REA 逆向）

> 工具：REA v6.1.0（`npx rea-agents@latest`）+ 源码直读（交叉验证）
> 分析对象：本机 AgentsRoom v1.202.0（`%LOCALAPPDATA%\Programs\AgentsRoom`）
> 基准：`main @ 608f794`（2026-10-08）
> 姊妹篇：`docs/agentsroom-collaboration-analysis.md`（协作全貌 §0–§13）；
> 本篇专答一个问题——**"AgentsRoom 的团队到底是什么"**，并给每个机制挂 REA 证据。

---

## 0. 一段话定义

**团队（Team）= 一张"代理步骤组成的有向图"，被持久化为云记录，由桌面端主进程
里的团队运行器（team runner）执行**：每一步是一个 PTY 里的真实 CLI 代理（Claude
Code / Codex / …），步骤之间用 **flag 路由**交接，图上可以分支、并行、循环、
暂停问人；运行状态机是 `pending → running → awaiting-* → done/cancelled/blocked`。

团队同时是两个正交维度的组合：

| 维度 | 取值 | 含义 |
|---|---|---|
| `mode` | `morphing`（默认）/ `messaging` | 一个代理依次扮演每个角色 / 每个节点一个常驻代理 |
| `routing` | `graph`（默认）/ `open` | 只有出边能推进 / **消息可寻址、无需收敛**（仅与 messaging 组合合法） |

（`teamsMcpTools.cjs: normalizeTeamMode / normalizeTeamRouting`，原文：
*"Anything that is not exactly 'messaging' is the default, pre-existing model"*、
*"Anything that is not exactly 'open' keeps the run inside its graph"*。）

---

## 1. 方法与 REA 运行记录

| 目标 | 命令 | REA 统计（`data.normalized_result.statistics`） |
|---|---|---|
| 团队文件集（17 个 `team*.cjs`，239 KB） | `analyze-javascript-application <team-set> --format md --full-output` | **17 文件解析、20,300 AST 节点、115 findings、0 解析失败**；证据哈希 `ev_ea591e15…`，subject digest `927fab76…` |
| 主进程原始 bundle（`dist-electron/main.js`，3.4 MB） | 同上 | **758,805 AST 节点、738 findings、0 解析失败**；证据哈希 `ev_3bd69377…` |

两个 REA 操作细节（踩坑，均写入证据）：

1. **prettier 美化过的 JS 会被 REA 拒收**：`main.pretty.js` 分析结果
   `invalid_utf8_files: 1, parsed_javascript_files: 0`（"无法 UTF-8 解码"），
   即 9 MB 文本 0 个 AST 节点；**必须用 asar 里的原始 `main.js`** 才能解析。
2. 团队 cjs 侧 `setInterval` 字面量 = **0 次**（REA md 全量检索）——
   这是有用的负证据：sidecar 是纯反应式的，所有定时器都在运行器侧。

REA 局限沿用姊妹篇 §2：工具名、状态枚举、数值上限在 REA 输出中**零证据**
（协议由字符串字面量 + 动态分发承载，命中 "dynamic names remain unknown"）。
故本篇的证据模型是：**源码直读为主、REA 提供独立的结构/字面量交叉验证**。

---

## 2. 团队的数据模型

### 2.1 团队记录（`teamsMcpTools.cjs` create 分支，L1581-1600 起）

| 字段 | 说明 | 备注 |
|---|---|---|
| `id` | nanoid | |
| `name` / `description` | 元信息 | **治理守卫下仍可 patch 的少数字段** |
| `scope` | `{kind: project, projectId}` / `{kind: global}` | 项目级 / 账号级 |
| `nodes` / `edges` | 图本体 | 校验 + 归一化后落库 |
| `maxCycles` | 单节点循环上限 | **save 时 `normalizeMaxCycles(raw, DEFAULT_MAX_CYCLES)`，`DEFAULT_MAX_CYCLES = 3`（L59）** |
| `agentExtraCyclesMax` | 允许代理自授的续命循环 | 0（默认关）–10 |
| `mode` / `routing` | 见 §0 | 归一化后落库 |
| `compactBetweenSteps` | 步骤间压缩上下文 | |
| `ignoreQuotaRules` | 绕过配额 | 节点级可再叠加 |
| `runOnce` | **运行结束后自删团队** | blocked 时保留以便续命；见 §3.3 |
| `autoFinalizeIdleMinutes` | 无人值守 run 的自动收尾定时器 | **生命周期契约未列此字段**（§9） |
| `createdBy` | `"agent"`（经 MCP 建）等 | 清理过滤器 `createdByAgent` 的判据 |
| `lastRunAt` | 桌面端在 run 启动时盖戳 | 本地 run 历史回填 |

### 2.2 节点类型（`capabilitiesTeamsContract.cjs: nodeKindContract`）

- `start`：恰好一个；唯一出边；**出边不可带条件**（首步之前不存在任何 flag）。
- `agent`：`role / provider / model / reasoningEffort / customSystemPrompt /
  stepInstructions / skills / handoffMode(auto|manual) / verifyInBrowser /
  browserUrl / readOnly / ownWorktree / checkCommand / checkFlag /
  checkIdleTimeoutSec(默认120) / checkMaxTimeoutSec(默认3600) / envVars /
  claudeProfileId / codexProfileId / extraAgent / launchCommand / agentTemplateId`。
- `await`：暂停问人；条件出边 = 人类选项，选中即把该边条件写进 flags。
- `end`：≥1；到达即进入 `awaiting-finalization`（等 finalize）。
- `group`：纯画布视觉框，运行器忽略。

### 2.3 边与 flag

`{id, from, to, label?, conditions?[{flag, equals}], conditionMode:'all'|'any'}`。
**没有 flag 注册表**：某 flag 存在只因某步发过它（生产者：代理自报 / 人类在
await 上选择 / 运行器测量门 `checkCommand` 覆盖自报）。
出边解析（`k_`/`ane`，§7 交叉验证）：无条件边兜底 → 条件边 AND/OR →
**最具体者胜**（条件数计分，平局取第一条）→ 无匹配即停（`no-route`）。

---

## 3. 团队在哪里存、有多大、怎么清理

### 3.1 存储（`teamsMcpTools.cjs` 头注释 + 读写路径实测）

- 项目团队：`/api/project-teams`（整读）+ **逐团队写** `/api/project-teams/team`
  （`projectTeamWrites.cjs`——旧行为是把整个列表挂在每次保存上，头注释原话
  "a 10 MB list no longer rides on every save"），写完回打本地缓存
  `.agentsroom/teams-cache.json`，桌面端下下次开面板即见。
- 全局团队：`/api/user-teams`；桌面端在本地 `~/.agentsroom/teams/` 离线库上
  按 `updatedAt` 调和。**MCP 绝不创建账号第一版全局行**（`updatedAt === null`
  是"从未同步"信号，抢先建行会破坏所有机器的首次迁移）——
  此时调用返回的是指引文案（去桌面开一次 Teams 面板）。
- 本地团队（seeded templates）只活在机器上，MCP 不可见、不可删。

### 3.2 限额（`projectTeamWrites.cjs` 常量，直读）

| 常量 | 值 | 语义 |
|---|---|---|
| `MAX_TEAM_BYTES` | **1 MB** | 单团队序列化上限 |
| `MAX_TEAM_LIST_BYTES` | **14 MB** | 项目团队列表总上限 |
| `LIST_WARN_RATIO` | 0.8 | 从 80% 起每次写都带 warning |
| `TEAM_LIST_TOO_LARGE` | — | 超限后**该项目所有团队的创建与编辑全拒** |
| `MAX_DELETE_IDS` | 5,000 | 单次 `teams_delete` 批量上限 |

### 3.3 清理契约（`teamListContract.cjs`，头注释即事故复盘）

> **Reported by Evelyn**：一个协调者代理**按任务建团队**，两周建出 1,161 个，
> 列表顶到服务端上限，此后一切创建失败，清理又要一个个删。

契约给出的正确答案（原文要点）：

- **不要按任务建团队**；按"流水线种类"建（build/check/review 各一个），
  任务 brief 放 backlog 票据（`backlog_create({teamId})` + `backlog_start_next`）——
  每次 run 都取**最新保存版本**，改团队即生效。
- 真要一次性图：`runOnce: true`（**done/cancelled 后自删；blocked 保留以便续命；
  从未运行则留到手工删**）。
- 清理用过滤器：`teams_list({ neverRun / notRunForDays / olderThanDays /
  createdByAgent / idsOnly })`，再 `teams_delete({ teamIds })` 批量。

---

## 4. 管理面：`teams_*` MCP 四工具（`teamsMcpTools.cjs`）

| 工具 | 关键行为（实测） |
|---|---|
| `teams_list` | 项目 + 全局（+folder 作用域）合并列出；`idsOnly` 精简返回；`projectList {teams, bytes, limitBytes, usedPercent}`；80% 起每次写附带 warning |
| `teams_get` | 全量 / **structure 视图**（节点与提示词替换为 `{chars, preview(80)}` + `omittedFields` 标记）/ **单节点视图**（`node: id` 取整节点 + 进出边）。**整团队序列化 >60,000 字符时自动降为 structure**（`FULL_VIEW_AUTO_TRIM_CHARS`，按最紧 CLI 的 ~25k token 结果预算定的） |
| `teams_save` | 创建必须给全图；更新可全量替换（`nodes`/`edges`）或**增量操作**（`addNodes/removeNodes/nodePatches/addEdges/removeEdges/edgePatches`，固定顺序 removeEdges→removeNodes→addNodes→nodePatches→addEdges→edgePatches），**全量与增量互斥**（同时给即拒绝）；**`dryRun: true` 只校验不落盘**（返回值与真保存同形，`wouldWrite:false`）；校验失败 = 阻塞 issue 全列；通过但带非阻塞 warning（`flag.padded` / `node.noFallback` / `fanout.sharedTree`）；**"push 是不回去的点"**——一切可能失败的步骤都在写入之前（注释署名 reported by Pedrofigueira87） |
| `teams_delete` | 单个或批量（≤5000）；**任意一个 id 被活 run 执行 → 整调用拒绝，什么都不删**（拒绝文案明确"not even the other ids"） |

校验器 `validateGraph` 是桌面端 `teams.ts::getTeamIssues` 的移植
（注释原文："so an agent cannot persist a team the runner could not execute"），
16 条阻塞规则（start 缺失/重复、end 缺失、无 agent、agent 无出边（openRouting
时放宽）、await 无出边/多无条件出边、边重复/含糊/矛盾、start 带条件、
fanout 从 start/分支非 agent/无 join/不收敛…）+ 3 条告警。
`openRouting` 下 fanout 类规则整段不跑——开道路由里"多条出边"是"同时寻址
多个队友"，本就不欠一个 join。

### 4.1 structure 视图的防呆设计（`teamsGraphView.cjs` 头注释）

**Reported by Pedro Figueira**：一个 12 个 persona 的团队序列化 10 万字符以上，
**工具结果装不下、persona 又是单个字符串无法分页**，代理连拓扑都读不到。
解法：structure 视图把两个长字段换掉，且被裁剪节点带 `omittedFields` 标记——
`teamsGraphOps.cjs` **拒绝保存带该标记的节点**，所以"读了 structure 直接回写"
永远不会静默抹掉它省略掉的提示词。

---

## 5. 治理守卫：运行中的团队定义对代理只读

这是团队机制里**最像安全设计的一块**（`teamsMcpTools.cjs: 936-1290`，
`GOVERNED_WRITE_TOOLS = ['teams_save','teams_delete','skills_save']`）。

### 5.1 为什么存在（头注释原话摘要）

> 代理执行团队 run 时，有一条直通路径能**改写正在治理它自己的工件**：
> 自己的 stepInstructions、测量它的 check 门、决定它之后跑什么的 routing，
> 乃至实现安全规程的 skill 正文。不是假想：某次 skill 正文被替换成字符串
> "OK"，那个 run 的代理们随后在"怎么理解这段退化文本"上分歧（有的停、
> 有的当成检查结果）。

### 5.2 规则与实现

- **活跃 run 状态下**（`pending/running/awaiting-handoff/awaiting-finalization/
  awaiting-user/blocked` —— **paused 也算活**，注释点名：漏掉 `awaiting-user`
  会让代理在暂停窗口里改写剩余步骤再被执行）该团队定义与它加载的 skills
  对 MCP 调用方**只读**。桌面 UI 不过这个 server，人类随时可改。
- 保护字段：`PROTECTED_TEAM_FIELDS`（nodes/edges/maxCycles/agentExtraCyclesMax/
  **mode/routing**/全部增量操作——"能把图约束团队翻成 open 团队"也算）与
  `PROTECTED_STEP_FIELDS`（19 个：role/provider/model/prompt/skills/check 门/
  readOnly/ownWorktree/profile 绑定…）；**name/description 放行**。
- 双信号溯源（防 CLI 过滤环境变量）：① 会话自己的 team env
  （`AGENTSROOM_TEAM_RUN_ID`+`_WORKSPACE`）；② **磁盘扫描** `<workspace>/.agentsroom/team-runs/`
  最新 25 个 run 的 `state.json`（`MAX_SCANNED_RUN_DIRS=25`）——能抓住**兄弟代理
  或用户的其他标签页**在改正在被执行的团队；目录 24 小时未触碰视为废弃
  （`STALE_RUN_MS`，防 crash 留下的 `status:"running"` 永久冻结团队），
  而会话信号无此截断。
- 拦截点：**dispatcher 在 handler 之前**调 `refusalForGovernedWrite`，
  拒绝时"从未开始写"（无半写）；`dryRun:true` 例外放行（校验不改写，
  注释："the moment checking is most useful"）。
- 拒绝文案按"受管代理"口吻：点名 run 与字段、"Nothing was written: the stored
  team is byte-identical"、指明出路（让用户在桌面面板改，或等 run 结束）。
- `annotateToolsForGovernance`：run 活跃时把 **GUARDRAIL ACTIVE** 注记
  直接追加进 `teams_save/teams_delete` 的工具描述——模型在调用前就读到规则。
  注释明确**只做描述级不做 schema 级**：把保护字段从节点 schema 里删掉，
  会让诚实的 `teams_get → teams_save` 往返**静默抹掉** stepInstructions/
  skills/checkCommand——正是要防的那种损坏。

---

## 6. 运行（Run）生命周期

### 6.1 状态与触发（运行器实测，姊妹篇 §11.1）

```
pending → running ⇄ awaiting-handoff ─┐
               │                        ├→ awaiting-user（await 节点 / needsInput）
               ├→ awaiting-finalization │   （只能由人回答；工具回答不了）
               │      ↑ 终结步骤可再次 complete 重开
               └→ blocked（3 个写入点）
终态：done（team-run:finalize）/ cancelled（team-run:cancel）
```

### 6.2 循环护栏与"3"的来源（修正姊妹篇 §11.2 的表述）

- 运行器：`bp(run) = team.maxCycles + (run.cycleBonus ?? 0)`，per-node 计数，
  超限 → `blocked`（节点路径 / 扇出路径 / 隔离检出无法供给三处）。
- **`DEFAULT_MAX_CYCLES = 3` 在 save 路径**（`teamsMcpTools.cjs:59,1598`：
  创建 `normalizeMaxCycles(args.maxCycles, DEFAULT_MAX_CYCLES)`；
  更新回退到已存值）。即：**MCP 保存的团队必有有限 maxCycles**；
  "运行器无默认"只对**旧版本写入的行**成立。
- 续命：`agentExtraCyclesMax`（0–10，默认关）内代理可经
  `team-run:reenter-node` IPC 自授 +1/+2；超额的只有人能加。

### 6.3 信号扫描与重启重臂（运行器，§11.3 已实测）

5 秒轮询 + `fs.watch` 去抖；`step-complete*.json` 按 mtime 窗口去重**且从不删除**；
重启时 `U1(rescan:false)` 只认新信号；`awaiting-input/agent-silent` 状态下的步骤
在重启后**不重新进入**（`C7e`）。

### 6.4 收尾语义

- `awaiting-finalization`：`team_finalize_run`（票据→done、拆临时控制台）/
  `team_cancel_run`（票据不动）；终结步骤可再次 `team_complete_step`
  **重开 run**（新 flags 路由）。
- 无人值守 run 另有 `autoFinalizeIdleMinutes`（§2.1）自动收尾通道。

---

## 7. 运行内协作协议（team-mcp-server，10 工具）

姊妹篇 §3 已全量取证，此处只列与"团队"直接相关的骨架：

| 工具 | 作用 |
|---|---|
| `team_get_context` | 抗压缩回归点：当前角色/周期/入站 payload/`stepInstructions` |
| `team_read_notes` / `team_post_note` | 共享 NOTES.md（追加式，默认 20k 字符尾读） |
| `team_read_timeline` | 事件日志（run-started / node-entered / handoff / run-stalled / run-ended / **model-switched** / step-complete-dropped…） |
| `team_read_inbox` / `team_send` / `team_ask` | 队友通信（messaging 模式实时投递；relay 模式留便条；预算 12/30/10min，**配对 10 条/10min**，重复 1h 守卫；`expectsReply` 单收件人，等待姿势=结束回合） |
| `team_roster` | 谁在线、我能写谁 |
| `team_read_diff` | 基线 git diff（60KB 封顶、20s git 超时） |
| `team_complete_step` | **唯一交接动词**：`{featureSummary 40–1500, risks[], testHints[], flags{}, nextNodeHint?, workspaceCwd?}`；每周期一次；路由门禁；`needsInput:true` 保留 flag 问人 |

身份解析六级链（roster → parallelSteps → 消息代理 NODE_ID → currentStep →
finalStep → env 兜底）解决"spawn 时冻结的 env vs 角色变形"的串号问题
（注释记录了三起真实串号事故）。

---

## 8. REA 证据与交叉验证（本篇新增）

| 断言 | 证据 | 来源 |
|---|---|---|
| 团队 sidecar 是纯反应式（无定时器） | `setInterval` 在 17 文件 REA 输出中 **0 次** | `team-set.md` 全量检索 |
| sidecar 只有 14 处 `execSync`（git diff、pty-owners 探测等） | `execSync` 字面量 14 次，child-process 家族 1 项 unknown-coverage | `team-set.md` |
| `AGENTSROOM_TEAM_RUN_ID` 的动态前缀读取 REA 只能部分追踪 | 8 次字面量，其中 `reads-property` 标 **ambiguous-target** | `team-set.md` semantic_graph |
| 运行器确有全局定时器 | `setInterval` 21 次 / `clearInterval` 29 次（含 5s 扫描） | `runner-raw.md` |
| 运行器文件系统面 | `readdirSync` 47 处（信号扫描 / run 目录枚举） | `runner-raw.md` |
| 主进程 env 面清单 | `AGENTSROOM_AGENT_ID` ×13、`AGENTSROOM_INIT_CMD` ×14、`AGENTSROOM_CLI_BINARY` ×4、`AGENTSROOM_PROJECT_ID` ×2、`AGENTSROOM_TEAM_RUN_ID` ×1… | `runner-raw.md` |
| 团队文件间的模块依赖图 | 115 findings，imports/exposes 边（`team-mcp-server` → 8 个兄弟模块等） | `team-set.md` graph |

**REA 操作教训（写入方法论）**：

1. `--filter-output` 的复合子键（`graph`、`summary` 等）在本版 CLI 上**大多静默
   失效**（只回 `limitations`）；可靠路径是 `--format md` 全量 + 本地检索。
2. **prettier 产物对 REA 是无效 UTF-8**（BOM/CRLF 问题）：runner 分析必须用
   原始 `dist-electron/main.js`。美化版只供人工/子代理直读。
3. md 渲染器对宽表的 properties/observations 列输出 `[object Object]`——
   图边细节要从 JSON 版或源码旁证。

---

## 9. 与既有契约/文档的漂移清单（更新至本次发现）

| # | 处 | 漂移 |
|---|---|---|
| 1 | `teamRunLifecycleContract` | 未列 `autoFinalizeIdleMinutes`、`runOnce`、`mode/routing` 三字段 |
| 2 | 同上 | `maxCycles=3` 的默认在 **save 路径**（本篇 §6.2 修正了姊妹篇 §11.2 的"运行器无默认"表述：运行器确实无默认，但 MCP 保存保证有限值；只有旧行可能缺） |
| 3 | `teamRunStallGuide` | `console-missing` / `agent-silent` 在桌面 bundle 中**无写入者**（姊妹篇 §11.7 已证实，本篇运行器 REA 未再产生新证据） |
| 4 | 契约未提 | `routing:'open'` 拓扑与"paused 也是活 run"的治理语义 |
| 5 | 限额 | 单团队 1 MB / 列表 14 MB / 批量删 5000 —— 数字在 `teamListContract` 有，但姊妹篇未收录 |

---

## 10. 对本仓库（AI Studio）的含义

1. **团队是票据的执行器**：`backlog_create({teamId})` + `backlog_start_next`
   是唯一启动通道（无"裸 teamId 启动"工具）；run 结束于
   `awaiting-finalization`，需要协调者代理**自己轮询并 `team_finalize_run`**
   （`backlog_get` 返回的 `run` 块 + 文案明示）。
2. **无人值守的完整闭环**：票据 → 团队 run →（QA 门 / 循环护栏 /
   autoFinalize）→ finalize 票据进 done。这套闭环与 AI Studio 工作区里
   正在落地的"项目化方案 A"（`apps/api/src/projects.ts`，§6.3 时效注记）
   是同层抽象：AgentsRoom 的 projectId 已把**协作面**项目化，
   AI Studio 的 projectId 做的是**业务数据面**项目化。
3. **治理守卫对自研层的可借鉴点**：AI Studio 的 `docs/project-scoped-refactor-plan.md`
   §4"治理网关"要解决的是"角色能否调此工具"；AgentsRoom 已给出一个可抄的
   范本——**保护字段枚举 + 双信号溯源 + 拒绝前不落盘 + 拒绝文案以"该做什么"
   结尾**。差别是 AgentsRoom 守的是"定义面"（团队/skill），
   AI Studio 要守的是"工具面"。

---

## 11. 未能确定（诚实清单）

- 团队运行器在**渲染进程 chunk 里**的 mobile 分支（`team-run:mobile:*` IPC
  已见 5 个通道，手机端语义未逐行读）。
- `governedSkills` 快照与 `skills_save` 拒绝的完整交互（本篇只覆盖了
  team 侧；skill 侧文件 `skillBundleMcp.cjs` 未 REA）。
- `compactBetweenSteps` 的实际压缩策略（字段存在，执行体在渲染/CLI 侧未定位）。
- 全局团队 `folder` 作用域（`LIST_SCOPES` 含 `folder`，语义未展开）。
- `opencode` 的 `/model` 活切与 `readOnly` 强制在 opencode 侧的实现
  （契约称 5 家 CLI 级强制，本篇未逐家验证）。

---

## 12. 证据索引

| 证据 | 位置 |
|---|---|
| 团队文件集 REA 输出（45 MB md） | `$PI_SCRATCH_DIR\rea\team-set.md` |
| 主进程 bundle REA 输出（158 MB md） | `$PI_SCRATCH_DIR\rea\runner-raw.md` |
| 团队 17 文件原样 | `$PI_SCRATCH_DIR\rea\team-set\*` |
| 团队管理面源码 | `resources\teamsMcpTools.cjs`（1,759 行）、`teamsGraphOps.cjs`、`teamsGraphView.cjs`、`teamsListFilters.cjs`、`teamsDeleteMcp.cjs`、`teamListContract.cjs`、`projectTeamWrites.cjs` |
| 团队 MCP 工具（run 内） | `resources\team-mcp-server.cjs` + 9 个护栏兄弟文件 |
| 运行器（混淆但字面量完整） | `asar\dist-electron\main.js`（93800-96900 行区，美化版 `asarwork\main.pretty.js`） |
| 协作总报告（§0–§13） | `docs\agentsroom-collaboration-analysis.md` |
