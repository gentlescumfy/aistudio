# AgentsRoom 整体架构分析报告（REA 逆向）

> 工具：REA v6.1.0（`npx rea-agents@latest`）+ 源码直读（交叉验证）
> 分析对象：本机 AgentsRoom v1.202.0（`%LOCALAPPDATA%\Programs\AgentsRoom`），解包 `app.asar` 全树
> 姊妹篇：`docs/agentsroom-collaboration-analysis.md`（协作 §0–§13）、
> `docs/agentsroom-team-analysis.md`（团队专题）；本篇回答一个问题——
> **AgentsRoom 作为软件系统，它是什么形状**。

---

## 0. 一句话架构

AgentsRoom 是一个**"代理编排桌面端"**：Electron 主进程持有全部**编排真相**
（团队 run 状态机、Agent Mail 队列、账本、密钥），把**执行权**交给任意多个
**外置 CLI 代理子进程**（15+ 种，经 PTY 运行），两侧用**磁盘文件 + 零依赖
MCP sidecar + 云端 API + wss 中继**四种介质交换事实；移动端与 SSH 远程宿主
都只通过桥接入，**不获得编排权**。

```
                 云端 agentsroom.dev（backlog/记忆/库/团队/obsidian 同步/更新）
                         │ HTTPS + wss relay（relay-na，区域化）
        ┌─────────────────┼──────────────────────────────┐
        │                 │                              │
   [手机 App]        [Electron 桌面端]             [SSH 远程宿主]
   pairing-token     ┌ main：run 状态机 / 邮件队列      pty-helper.py 真 PTY
   推送 / 远程回答     │              / 密钥 / 账本        + AGENTSROOM_TEAM_BRIDGE_FILE
                     │        │ preload：electronAPI + bridgeAPI（423 invoke / 164 on）
                     │        ├ 渲染：UI / 邮件 PTY 投递 / 模型切换分发
                     │        ├ 本地桥 ×4：browser-bridge :53413 / hook-endpoint :53412
                     │        │   / extension-bridge(token+installId) / relay
                     │        └ 子进程森林：
                     │             N × PTY 代理（claude/codex/gemini/cursor/grok/
                     │             kimi/omp/devin/copilot/aider/opencode …）
                     │               每个 CLI 侧挂 stdio MCP sidecar（5 种）
                     │             pty-helper.py（远程真 PTY）
                     │             pyconnectors（WinRM/Kerberos/SMB/PS 管道）
                     └────────────────────────────────────────
```

---

## 1. 证据基础（四轮 REA + 直读的分工）

| 层 | 证据 | REA 统计 / 检索结果 |
|---|---|---|
| 整包 Electron 边界 | `agentsroom-analyze.md`（400 MB） | 2,119 文件 / 47,393 findings；**4 browser windows、1 preload、2 contextBridge API、190 个 exposed_api_members、1,209 IPC operation、652 字面 channel、503 对可配对、15 未配对、34 动态 channel、30 处 sender 校验观察** |
| 主进程运行器 | `runner-raw.md`（158 MB） | 3.4 MB 原始 `main.js` → **758,805 AST 节点、738 findings、0 解析失败**；`setInterval`×21 / `readdirSync`×47；env 字面量清单 |
| 团队文件集 | `team-set.md`（45 MB） | 17 文件 / 20,300 AST 节点 / 115 findings；**sidecar 侧 `setInterval`×0** |
| 协作 / HITL / 模型切换 | 前两轮直读 | 见姊妹篇 §3–§12 |

三条操作性教训（都影响可复现性）：prettier 产物 REA 判无效 UTF-8，必须用原始
`main.js`；`--filter-output` 复合子键大多静默失效，走 md 全量+检索；
md 宽表列渲染 `[object Object]`，图边细节需源码旁证。

---

## 2. 进程拓扑（七类执行体）

| # | 执行体 | 位置 / 载体 | 职责 | 与"编排真相"的关系 |
|---|---|---|---|---|
| 1 | **main 进程** | `dist-electron/main.js`（3.4 MB bundle） | run 状态机、邮件队列、密钥注入、账本、423 个 invoke 面 | **唯一持有者** |
| 2 | **渲染进程** | `dist/assets`（React；单 chunk 最大 51 MB） | 组织视图 UI；**邮件 PTY 投递的实际执行者**；模型切换分发器 | 只读/触发 |
| 3 | **preload** | `preload.js`（67 KB） | 两个暴露面：`electronAPI` / `bridgeAPI`；423 invoke + 164 on | 桥 |
| 4 | **PTY 代理控制台** | `node-pty`（mac/linux）；Windows 用 ConPTY，**`pty-helper.py` 兜底**（bundle 内 11 处 `pty-helper`、3 处 `ConPTY` 标记） | 跑 15+ 种 CLI | 纯执行 |
| 5 | **MCP sidecar**（5 种） | `resources/*.cjs`（零依赖、ES5、"runs on the USER's node, not Electron's"） | `app-mcp-server`（主工具箱）/ `team-mcp-server`（run 内 10 工具）/ `browser-mcp-server` / `test-runner-mcp-server` / `qa-tester-mcp-server` | 工具通道，身份由 env 盖章 |
| 6 | **Python 侧件** | `pty-helper.py`、`pyconnectors/`（WinRM/Kerberos/SMB/PS 管道）、`hooks/`（`team-reminder.py` Claude UserPromptSubmit、`notify-agentsroom.py`） | 真 PTY 代理 / 远程机器通道 / 每回合团队上下文重注入（抗压缩） | 被调度 |
| 7 | **远程宿主** | SSH 机器上的代理 + 桥文件 | 远程 run；**状态仍写回桌面端**（`teamRunStore` 远端桥，`Atomics.wait` 保持同步语义） | 执行 |

原生依赖只有 `node-pty`（可选）+ `appdmg`；但主进程**捆绑了大量"基础设施"**
（§3）——它不是纯 UI 壳。

---

## 3. 主进程捆绑的能力面（"应用即基础设施"）

`main.js` 内字面量检索（原始 bundle）：

| 能力 | 标记命中 | 架构含义 |
|---|---|---|
| **MongoDB 驱动** | `mongodb`×74（`MongoDBInvalidArgumentError` 全表） | `db_*` 工具直连，驱动打进 Electron |
| **MySQL** | `mysql2`×5、`ER_*` 错误表 | 同上 |
| **Kerberos / WinRM / SMB** | 15 / 36 / 12 | Windows 远程机器一等公民（`pyconnectors` 是 Python 侧，主进程管凭据与 IPC） |
| **WebSocket** | ×14 | 手机中继 / 扩展桥 / 远程桥共用 |
| **Obsidian / Notion / Jira / GitLab / AWS** | 16 / 17 / 14 / 16 / 2 | 外部系统集成内置 |
| **electron-updater** | ×1 | `app-update.yml` → `agentsroom.dev/downloads`（generic 提供商） |
| **node-pty** | ×5 | 终端一等公民 |

**结论**：桌面端是一个**带终端编排能力的小型 PaaS**——数据库、远程机器、
笔记、工单、更新全在主进程，代理 CLI 只是它的"执行后端"。

---

## 4. IPC 面（423 invoke / 164 on，按家族分类）

preload 实测通道家族（按出现次数）：

```
  57 sync        36 pty        35 team-run   34 agent      27 git
  24 agent-mail   21 ssh       20 bridge     20 island     20 browser
  19 fs          17 usage      16 window     16 chrome-control   16 db
  10 auth         9 auto-update 9 app        9 vault        9 github
   8 cli          8 composer-bridge  8 preview  8 hook
   7 wake-schedule  7 backlog   7 codex   7 obsidian-sync  7 notion
   7 gitlab       …（再往下 50+ 个家族 ×2-7）
```

按架构角色归并：

| 角色域 | 家族 |
|---|---|
| 终端/代理 | `pty` `agent` `team-run` `team` `agent-mail` + 每 CLI 一家（claude/codex/grok/antigravity/omp/opencode/kimi/cursor/mistral） |
| 版本控制 | `git` `worktree` `commit` `skill-git` `github` `gitlab` |
| 远程基础设施 | `ssh` `db` `aws` `vault` `secrets` |
| 外部集成 | `jira` `notion` `obsidian-sync` `marketplace` `gist` `triggers` |
| 桌面 UI | `window` `island`(Dynamic Island) `ui` `gpu` `splash` `fonts` `media` `voice-mode` `region-screenshot` |
| 治理/安全 | `auth` `process-guard` `tool-approval` `command-proposal` `agent-permission` |
| 云/移动端 | `relay` `sync` `broadcast` `remote-update` |
| 浏览器 | `browser` `chrome-control` `browser-mcp` `preview` |
| 用量/计费 | `usage` `usage-pace` |
| 生命周期 | `auto-update` `boot-recovery` `keep-awake` `launch-at-login` |

REA 整包观察的 **15 个未配对 renderer channel + 30 处 sender 校验观察**
（REA 明确不证明完整授权策略）——是这套 IPC 面的**已知待审计项**。

---

## 5. 数据面：三个域 + 云端（写入方向各不相同）

| 域 | 位置 | 写者 | 同步语义 |
|---|---|---|---|
| **项目域** | `<project>/.agentsroom/`（缓存、`team-runs/`、`sessions/`、`agent-mail/`、`memory/` 镜像、`handoff-*`） | 桌面端重写；**代理唯一可写自己的 session file** | 本地优先；记忆是服务端行的单向镜像 |
| **全局域** | `~/.agentsroom/`（`settings.json`、`roles/`、`agent-prompts/`、`pty-owners.json`、四个桥文件） | 桌面端独占 | `roles-sync-state.json`（37 KB）做角色同步状态 |
| **云端域** | `agentsroom.dev`（`/api/*` 主进程 13 路 + sidecar 12 路） | 桌面端与 MCP 双路 | backlog/记忆/全局库**云优先**（应用关闭仍可用）；**Agent Mail 本地优先**（收件人是本机控制台，应用关闭无人可投递） |

两个刻意的取舍（源码注释原文）：
- *"a mailbox is local by nature… that is the opposite trade-off from the
  backlog/memory families, which are cloud-first"*
- 零依赖 sidecar 与主进程共享的常量**只能逐字复制**（"Duplicated on purpose"）
  ——这是契约漂移（团队篇 §9）的结构性根因。

本地桥文件实测（`~/.agentsroom/`）：

```
browser-bridge.json   port 53413 + token + pid      嵌入式浏览器 CDP 面
hook-endpoint.json    port 53412 + token + pid      Claude hooks → 桌面回传
extension-bridge.json token + installId             浏览器扩展（chrome-control）
relay-selection.json  { id:"na", url:"wss://relay-na.agentsroom.dev" }  区域化中继
pairing-token         16 字符                        手机配对
live-activity.key / pty-owners.json / pty-pids.json  运行态身份
```

---

## 6. 与 CLI 生态的集成（"接线"不是 fork）

每个 CLI 的写入物四类（13 个 per-provider 配置写入器）：

| 类别 | 实例 |
|---|---|
| MCP 配置 | `.mcp.json`(claude/copilot)、`.agents/`(gemini/antigravity)、`.grok/config.toml`、`.vibe/`(mistral)、`.kimi-code/`、`.amp/`、`.omp/`、`.devin/`、`.cursor/` |
| 提示词 | `~/.agentsroom/agent-prompts/<id>-boot.md`（角色 + 工具礼仪 + session file 约定） |
| 原生插件 | `resources/opencode/`、`resources/omp/`（不走 MCP，走自家插件 API） |
| 钩子 | `resources/hooks/team-reminder.py`（每回合重注入团队上下文，**抗上下文压缩**） |

同一能力按 CLI 降级：`/model` 活切 7 家（§协作 12.1）；`readOnly` 团队步骤
只有 5 家 CLI 级强制；`detectBusy/detectNeedsInput/detectLiveBackgroundWork`
**每 CLI 一套输出解析器**——这是主进程"读懂 15 种终端"的代价所在。

---

## 7. 移动端与中继（远程不获得编排权）

- **pairing**：`pairing-token` 文件 + `relayWsUrl`；中继按区域选择
  （`relay-na` 即美东）。
- **通道分工**：`team-run:mobile:*` 5 个 IPC（start/cancel/close-consoles/
  dismiss/finalize）——手机是**远端监控与回答 `awaiting-user`** 的面，
  run 状态机仍在桌面 main。
- **推送**：`mobilePushToken` + 手机推送（`agentPhoneNotifications`）；
  会话文件 `needsInput` 是"代理在等你"的规范信号（姊妹篇 §5.2）。

---

## 8. 远程执行（SSH 宿主 + 用户机器清单）

| 场景 | 机制 |
|---|---|
| 把 run 放到 SSH 机器 | `pty-helper.py`（真 PTY + 前台作业监控）+ `AGENTSROOM_TEAM_BRIDGE_FILE` 把 run 状态写回桌面；`teamRunStore` 远端桥用 worker + `Atomics.wait` 保持同步 API 不变 |
| 用户的远程机器 | `ssh_*` 工具 → `pyconnectors`（WinRM 默认只读、Kerberos、SMB 传输）+ `elevate.exe` 提权；凭据全在 OS keychain，**主进程只注入、不展示** |
| 数据库 | 内置驱动（§3）+ `db_*` 工具；写需逐连接 "Allow agents to write" 勾选 |
| 密钥 | `{{secret:NAME}}` 引用只经**PTY 创建时**注入进程环境；值永不进对话/文件/参数 |

---

## 9. 更新与生命周期

- 自动更新：`electron-updater` + `app-update.yml`（`agentsroom.dev/downloads`，
  generic 提供商），`auto-update:*` 9 个 IPC。
- 自恢复：`boot-recovery`、`keep-awake`、`launch-at-login`、
  `processGuard`（本实例：`enabled=true, autoKill=false, memoryMb=2048, idleMinutes=5`）
  ——**看门狗是提醒而非强杀**。
- 崩溃面：主进程 `G_`（end-run writer）统一写 `run-ended` 事件再删内存条目，
  磁盘上永远有一份可重建的真相。

---

## 10. 安全模型（八条，全部有源码证据）

1. **身份不可伪造**：MCP 调用方 `callerAgentId` 只来自 `AGENTSROOM_AGENT_ID`
   （env 缺失时 `pty-owners.json` 祖先链回退）；工具参数**永远**不接受身份。
2. **治理守卫**（团队篇 §5）：活 run 中团队/skill 定义只读，双信号溯源，
   拒绝在 handler 前，"byte-identical" 承诺。
3. **密钥不落地**：§8 的 `{{secret:NAME}}` 单门注入。
4. **写隔离**：`readOnly` 节点、`ownWorktree` 分支、`fanout.sharedTree` 告警。
5. **IPC 审计面**：REA 30 处 sender 校验 + 15 未配对 channel = **已知未闭环**。
6. **失败即封闭**：worktree 解析失败 → `start_refused` 回退票据；
   存储故障 → 503 而非半写；信号文件缺 vs 桌面不可达 → 不同的失败语义。
7. **可逆性优先**：邮件 append-only 事件流；取消 ≠ 完成；记忆 upsert；
   handoff summary 用完即删（唯一例外，防陈旧）。
8. **本地优先的隐私边界**：Mail 不上云；`analyticsOptedOut` 键存在
   （本实例值见 `settings.json`）。

---

## 11. 设计哲学（从逆向读出的五条）

1. **编排与执行分离**：代理可换（15+ CLI）、可崩、可远端，
   编排真相永远在桌面 main + 磁盘。
2. **为 LLM 读者写 API**：每个上限同时进工具描述与拒绝文案；
   拒绝句以"该做什么"结尾（"stop, do not retry"）；`capabilities_get`
   把连接契约机器可读化——**文档即护栏**。
3. **文件是事实**：跨进程/跨机事实全落盘（state.json / 事件流 / 信号文件 /
   桥文件），任何一侧重启后都从盘重建；`mtime` 窗口而非删除做去重。
4. **零依赖 sidecar 的代价**：随包 CJS 在用户 Node 上跑 → 常量双源复制
   → 契约漂移只能靠"同 commit 人工同步 + 契约文案"兜底（实测 5 处漂移）。
5. **桌面端即基础设施**：数据库驱动、远程机器、笔记、工单全内置，
   代理是"执行后端"——与"代理即 IDE"（Cursor 路线）是相反的产品决策。

---

## 12. 对本仓库（AI Studio）的含义

- 工作区里的 `docs/architecture-map.md` 与 AI Studio 自研层
  （`apps/api` + `services/langflow`）是**同一决策的小号**：
  编排（Langflow 图）与执行（代理/模型调用）分离，磁盘 store 为真相。
  差别是 AI Studio 面向**业务 SOP**，AgentsRoom 面向**开发任务流**。
- 直接可抄的三件：① 治理守卫（团队篇 §5）对应自研层"治理网关"
  （`project-scoped-refactor-plan.md` §4，`maxSteps/maxToolCalls/maxCost`
  至今未被 `engine.ts` 读取——姊妹篇 §6.3）；② "拒绝文案以行动结尾"
  的错误设计；③ `writer.lock` 每目录独立锁（AI Studio `FileStore` 已同构）。

---

## 13. 未能确定（诚实清单）

- 渲染进程 51 MB chunk 里的 PTY 投递函数体（`rr`/`Al`）与 15 个未配对
  channel 的授权实现——**只定位到调用点**。
- 移动端（`team-run:mobile:*`）服务端协议细节与中继鉴权升级路径。
- `usage`/`usage-pace`（17 个通道）背后的计费模型。
- 云端 `agentsroom.dev` 的部署形态（只能从客户端契约反推）。

## 14. 证据索引

| 证据 | 位置 |
|---|---|
| REA 整包（Electron 边界/IPC 面） | `$PI_SCRATCH_DIR\rea\agentsroom-analyze.md`（400 MB） |
| REA 主进程原始 bundle | `$PI_SCRATCH_DIR\rea\runner-raw.md`（158 MB） |
| REA 团队文件集 | `$PI_SCRATCH_DIR\rea\team-set.md`（45 MB） |
| preload 通道家族统计 | `$PI_SCRATCH_DIR\rea\ipc-families.txt` |
| 解包全树 | `$PI_SCRATCH_DIR\asar\`（2,376 文件 / 104.5 MB） |
| 四个本地桥 + 配对 + 中继选择 | `~\.agentsroom\{browser-bridge,hook-endpoint,extension-bridge,relay-selection,pairing-token}.json` |
| 协作总报告 / 团队专题 | `docs\agentsroom-collaboration-analysis.md` / `docs\agentsroom-team-analysis.md` |
| 主进程 prettier 展开（可读版，§15 行号基准） | `$PI_SCRATCH_DIR\asarwork\main.pretty.js`（125,702 行） |
| 渲染端 chunk 与双 HTML 入口 | `$PI_SCRATCH_DIR\asar\dist\`（`index.html` / `island.html` / `assets/`） |

---

## 15. 补充核实（第二轮源码直读，2025-07-20）

> 针对 §0–§14 的四处精化；行号基准为 `asarwork\main.pretty.js`（prettier 展开的原始 `main.js`，125,702 行）。

### 15.1 Provider 二进制映射（主进程常量 `hs` / `fX`）

14 家外置 CLI 及其实测二进制名与 home/bin 提示（`main.pretty.js:68288` 一带）：

| provider key | 二进制 | home 段 / `%LOCALAPPDATA%` 段（`fX`） |
|---|---|---|
| claude | `claude` | — |
| codex | `codex` | — |
| copilot | `copilot` | — |
| antigravity | `agy` | `LocalAppData\agy\bin` |
| opencode | `opencode` | `.opencode/bin` |
| aider | `aider` | — |
| grok | `grok` | `.grok/bin` |
| mistral | `vibe` | `.vibe/` |
| kimi | `kimi` | `.kimi-code/bin` |
| amp | `amp` | `.amp/bin` |
| omp | `omp` | `LocalAppData\omp` |
| freebuff | `freebuff` | — |
| devin | `devin` | `LocalAppData\devin\cli\bin` |
| cursor | `cursor-agent` | — |

→ 架构结论强化：§0 的「外置 CLI 子进程」在代码里是**逐 provider 的 shell 命令构造**——主进程按 key 取二进制名 + home 段，拼出带 env 的启动串再交 PTY（§2.4），并非内置模型运行时。

> **v1.202.0 provider 集合纠偏**：上表是 `hs` 二进制名映射；**权威启动开关**在 `main.pretty.js:123332–123437`，逐分支处理 `claude/codex/copilot/opencode/aider/grok/antigravity/mistral/kimi/amp/omp/freebuff/devin/cursor` + `default=custom`。**本 build 的 provider 里不含 `pi`、`workbuddy`、`cline`、`gemini`**（gemini 仅作为 antigravity 的模型别名 `main.pretty.js:89401` 与 `GEMINI_API_KEY` env `:96981`）。provider 可**服务端热加**：渲染端 `fetch(\`${apiBaseUrl}/api/config\`)` 返回 `providers[]` / `cliInstallCommands` / `minCliVersions`（主 chunk @109507）。§0「15+」是跨版本上界，v1.202.0 实测 14 + custom。

### 15.2 MCP 注入装配函数（主进程 `BDe` / `vDe` / `Y0`）

每个 CLI 会话按 `e.names` 生成一组 `mcpServers`（`main.pretty.js:77555` 一带）：

- `app-mcp-server.cjs`：env `AR_PROJECT_ID` / `AR_PROJECT_PATH` / `AR_DESKTOP_PROJECT_ID` / `AR_API_BASE_URL` / `AR_SETTINGS_FILE` / `AR_APP_VERSION` / `AR_BRIDGE_FILE`（主工具箱）
- `test-runner-mcp-server.cjs`、`qa-tester-mcp-server.cjs`：env `AR_BROWSER_BRIDGE_FILE` + `AR_BROWSER_PROJECT_ID`（test-runner 多一个 `AR_PROJECT_PATH`）
- `browser-mcp-server.cjs`：仅当 `includeBrowser`
- `team-mcp-server.cjs`：仅当 `teamServerName`，env `AGENTSROOM_TEAM_BRIDGE_FILE`

全部 `command:"node", args:["<resourcesPath>/<server>.cjs"]`（stdio）。身份靠 env 盖章（§10.1 `AGENTSROOM_AGENT_ID`）；本条给出的是**装配函数本体**，与 §2.5「5 种 sidecar」对齐。

### 15.3 CODEX_HOME 每 agent 隔离 + 三方 auth 归一

- `CODEX_HOME = "$HOME/.agentsroom/codex/<agentId 白名单化>"`（`kX=".agentsroom/codex"`；`UX` 把非 `[a-zA-Z0-9_-]` 换成 `_`；`NR` 拼路径，`main.pretty.js:69227` 一带）
- 启动/落盘串（POSIX）：`export CODEX_HOME=… && umask 077 && d=… && mkdir -p "$d" && cat > "$d/auth.json" && ln -s …/config.toml …`
- auth.json 三方（local / remote / shipped）状态机 `tTe`：`identical` / `keep-local` / `adopt-remote`；远程侧 `remoteCodexAccount` 负责 upload / adopt

→ 每 agent 凭据互不串号；远程 codex 账号可「收养」本地或反之（§8 远程执行的凭据面细化）。

### 15.4 渲染端模块图（`asar\dist\` 实测）


- 主窗 `index.html` → 引导 `main-aJ7qfTYK.js`（267 KB，React 19.2.4 `createRoot`，**无路由**，`?panel=…` 查询串切 `ProjectWindowApp`/`DetachedPanelApp`，默认 `App-C0hAv7wS.js`）→ 共享 UI chunk `useUiZoom-EqZjYQwe.js`（**5.16 MB**，含 xterm.js 终端、agent-mail UI、team-runs 状态、skills 视图；chunk 名取自其一导出 `useUiZoom`）
- 浮动子窗 `island.html`（"Dynamic island"，§2.2 的 Dynamic Island）→ `island-BKMBvWKn.js`
- 内置图形/可视化栈：`cytoscape` + `cose-bilkent`（力导向布局）+ `wardley` + `architectureDiagram` + `sequenceDiagram`（Mermaid/Cytoscape 系）→ UI 内直接渲染**架构/时序/Wardley 地图**
- 白板 `excalidraw-assets/`；本地语音转写 `whisperWorker`（Web Worker）；公式 `katex`

- 状态存储：**手写 store 工厂 + `useSyncExternalStore`（非 Zustand/Redux）**。实测符号：`useSettingsStore`（主 entry，持 `apiBaseUrl` / `authToken` / `defaultProvider:"claude"` / `mcpServers`）、`useProjectStore`、**`useTerminalStore`（本 build 的「会话」store：`.sessions` / `findSessionByPtyId`，bundle 内**无 `useSessionStore` 符号**）**、`useBacklogStore`、`usePromptHistoryStore`、`useUiZoom`；`index-*.js` 多为 **Monaco 语言/图标/本地化 chunk，非视图**；`DbTransferNotifier` 做 SQLite→UI 通知

→ 渲染端不止「终端回显」，内嵌**设计/可视化/白板/本地 STT**；但**邮件 PTY 投递与模型切换分发仍在本端执行**（§2.2、§13），编排真相仍只在 main。两条修正：渲染端**直连云 API**（`window.electronAPI.getAuthToken()` 取 Bearer 后 `fetch(${apiBaseUrl}/api/…)`，并非全部走 main）；桥对象是**单一扁平 `window.electronAPI`**（~150 命名空间 + 直挂 `createPTY/writePTY/agentMail*`），**不是 `window.electron`**。


### 15.5 云/桥端口实测修正

- **本地桥多为动态端口**：`createServer().listen(0, "127.0.0.1")`（`main.pretty.js:12248 / 66622 / 76868 / 92298`），实际端口写回 `~/.agentsroom/browser-bridge.json`、`hook-endpoint.json`。§5 的 `:53413` / `:53412` 是**某次运行观察值**，不是协议常量。
- 云端常量：`https://agentsroom.dev`（主 API，`OP` / `i7e`）；`wss://relay.agentsroom.dev`（中继默认，`Kde`；`relay-na` 为区域化，见 `relay-selection.json`）；`wss://preview.agentsroom.dev/register`（预览注册）。
- **Git 集成双轨**：`github.com` / `api.github.com` 特判 + GitLab 形态 `https://<host>/api/v4`（`baseApiUrl`）——对应 §4 的 `github` / `gitlab` 两个家族是真实双协议。

> 本轮新证据落在 `asarwork\`（main.js / main.pretty.js / preload.js）与 `asar\dist\`（渲染端），已并入 §14 索引。

### 15.6 子代理全量复核（main 全顶层函数 + 渲染端 2,013 chunks）

> 由 explorer 子代理对 `main.pretty.js` 全顶层函数与 `asar\dist\assets` 全 chunk 二次扫描补全。**路径澄清**：渲染端在 `asar\dist\`（**非** `asarwork\renderer`）；`main.pretty.js` 为 **UTF-16LE**（故被读工具判为 binary，需 PowerShell 读）。

新增/复核的子系统（行号在 main.pretty.js）：

| 子系统 | 行号 | 说明 |
|---|---|---|
| **QA runner**（独立于 team runner） | 125350–125360 | `qa-run:agent-spawned`、`qa-runs:list/get/cancel` |
| **遥测在渲染端** | 主 entry @35197 | `/api/v1/collect` + `/api/v1/consent` + `VITE_ANALYTICS_WRITE_KEY_DESKTOP`，`surface:"electron"`；opt-out 键 `analyticsOptedOut`（main 77536）。main 侧另有 `mcp-events:*` trace（105415） |
| **无独立 daemon** | — | "daemon" 仅作 MySQL 协议常量（28143）；远程控制 = 中继（§7）+ 开机自启的本地 **hook server**（`x5e()` 125055） |
| 数据库工具 | 115720–116540 | 完整 MongoDB 驱动 + `db:*`（dump/import/copy） |
| 凭据保险库 | `vault:*` 115959 / `secrets:*` 78441 | 与 §8 密钥面互补 |
| 工单导入 | 103528–104842 | github/jira/notion/gitlab 四源 + `import-attachments:fetch` |
| 用量/配额引擎 | 112572–115270 | §4 `usage` / `usage-pace` 背后的引擎 |
| 手机/扩展 hub | `deviceHub:send-input/launch-agent`、`agentsroom://install-agent` 125005 | 手机与浏览器扩展经 deviceHub 接入 |
| SSH 远程桌面 | 78165–78366、116803–117237 | `ship-codex-account` / `ship-agent-tools` / persistent-launch |
| Monaco 打进 main | `zBe` 82242–88421 | 主进程 bundle 内含 Monaco 核心（编辑/比对） |

渲染端结构修正：React 19.2.4 `createRoot` **无路由**（URL 查询串切面板）；`useUiZoom-*.js`（5.16 MB）实为**共享 UI chunk**（含 xterm.js）；`index-*.js` 是 Monaco 语言/图标/本地化 chunk，**非视图**；会话 store 是 `useTerminalStore`（**无 `useSessionStore`**）；`island.html` 浮岛由 `islandTeamRuns-*.js` 聚合 team-run 的 needs_input/thinking/done。

> 与 §0–§14 无冲突，属**补全 + 纠偏**（provider 集合、store 框架、桥对象名 `electronAPI`、渲染端直连云、无 daemon）。
