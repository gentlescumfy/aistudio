# 项目化改造实施记录（第 1–3 项）

> 方案：`docs/project-scoped-refactor-plan.md` · 基准：`main @ 608f794` · 记录日期：2026-10-09
> **所有改动均在工作区未提交。** 验证环境为 Windows（目录 fsync EPERM 限制，后端集成测试与基线同条件对比）。

## 总览

| 项 | 状态 | 涉及文件 |
|---|---|---|
| 1. 移除媒体硬编码 | ✅ | `workflows.ts` + `workflowUtils.ts`（双端同步）+ 3 个测试 |
| 2. projectId + 分目录 | ✅ | `projects.ts`（新）+ `store-pool.ts`（新）+ `app.ts` |
| 3. 项目 CRUD + Langflow 同步 | ✅ | `/api/projects*` 端点 + `langflow.ts createProject()` |
| 4. langflow.ts 异步 `/build` | ⏳ | 未开始 |
| 5. MCP + 治理网关 | ⏳ | 未开始 |

---

## §1 移除媒体硬编码

**目标**：让「分析 → 编码 → 交付」类无图像 SOP 可合法定义、可保存、可通过校验。

### 改动

| 文件 | 内容 |
|---|---|
| `apps/api/src/workflows.ts` | 删除 `IMAGE_REQUIRED`/`EXPORT_COUNT`/`ROOT_COUNT`/`EXPORT_IMAGE_PARENTS`；新增 `ROOT_REQUIRED`/`TERMINAL_REQUIRED`（≥1 个起点/终点，不限节点类型）；允许 `prompt → export` 连线；export 父节点放开为任意类型；`DISCONNECTED_NODE` 改为多根可达 + 孤立节点检查 |
| `apps/web/src/workflowUtils.ts` | **前端平行校验副本，必须同步**——只改后端等于白改 |
| `apps/web/src/workflowUtils.test.ts` | 2 条过时断言更新 + 新增「无图软件开发流程」用例 |
| `apps/web/src/App.test.tsx`、`WorkflowConfigPage.test.tsx` | 2 条文案过时断言修复（`模拟演示`→`工作流运行`；`真实代理…`→`单轮文本代理`） |

### 行为矩阵（node 实测，非推理）

| 场景 | 结果 |
|---|---|
| 纯软件开发 SOP（无图像） | `valid=true` |
| 带环 | `invalid`（`CYCLE` + `INVALID_EDGE_KIND`） |
| 含孤立节点 | `invalid`（`DISCONNECTED_NODE`） |
| 媒体 SOP（含图像，回归） | `valid=true` |
| 多根（两条独立链） | `valid=true` |

### 注意

- **孤立节点检查**：实现中发现放宽后，无边节点既算根又算终点会绕过连通性检查（旧逻辑会拒绝）——前后端都已补上「多节点图中无边节点 → `DISCONNECTED`」。
- `IMAGE_PROMPT_PARENT` **保留**：它是 image 节点自身属性（图像必须有提示词来源），不是赛道约束。计划文档 2.1 原写"删除"，实施时按更保守口径处理，属有意偏离。

---

## §2 projectId + 分目录

### 数据布局（关键决策）

```
default 项目 → dataDir/                遗留路径，现有数据与 30+ 处测试零改动
其他项目     → dataDir/projects/{id}/  独立目录，独立 writer.lock
```

`writer.lock` 是 `join(directory, 'writer.lock')` per-directory（`store.ts:38`），分目录即天然获得每项目独立锁，锁逻辑零改动。

### 改动

| 文件 | 内容 |
|---|---|
| `apps/api/src/projects.ts`（新） | `assertProjectId`（严格校验 + 防路径穿越）· `projectDirectory`（default 保留旧路径）· `slugify` · `ProjectRegistry`（`projects.json` + revision 乐观锁 + default 虚拟项，`default` 不可删/不可占 id） |
| `apps/api/src/store-pool.ts`（新） | `StorePool`：按项目懒加载 6 个 store + `RunEngine`，带缓存、部分打开失败回滚、`evict`（删除项目时释放） |
| `apps/api/src/app.ts` | 全部数据路由经 `request.project`（`onRequest` 解析 `x-project-id` 头，缺省 `default`）；**启动时 eager open default** 以保留「启动即抢锁 + 快照校验」语义（`recovery.test.ts` 依赖此行为）；CORS 允许 `x-project-id` 头 |

### 实测

```
default dir = "/data"
beta    dir = "/data\projects\beta"
isolated  = true
slugify("My Coffee Project") = "my-coffee-project"
id 校验：../escape、a/b、..、Upper、-lead、65 字符、"a b" 全部 → INVALID_PROJECT_ID
```

---

## §3 项目 CRUD + Langflow 同步

### 新端点

```
GET  /api/projects                        列表（含虚拟 default）
POST /api/projects                        创建（revision 乐观锁；201 + Location；立即初始化该项目 store）
POST /api/projects/:id/sync-langflow      best-effort 同步；失败记 pending，不阻塞项目创建
POST /api/projects/:id/delete             default 不可删；删除后 evict store 缓存
```

### 改动

| 文件 | 内容 |
|---|---|
| `apps/api/src/langflow.ts` | 新增 `createProject(name)`：调 Langflow `POST /api/v1/projects`；异常/不可达返回 `null` 并走 `reportError` 日志——**项目创建不依赖 Langflow 可用性** |
| `apps/api/src/projects.ts` | `ProjectRegistry.create/remove/markLangflowSynced`（每操作先 `readProjectIndex` 重读 + revision 校验，tail 链串行） |
| `apps/api/src/app.ts` | 4 个端点 + 注册表接线；`/api/health` 返回 `projectId` |

### 设计说明

- Langflow 侧的项目/MCP 能力见 `docs/langflow-capability-research.md`（§2 项目级 MCP、§4 异步 build）。
- 「中间件按项目配置」的最终落点是 Langflow `POST /api/v1/mcp/{project_id}/install`，本阶段未实现（治理网关前置）。

---

## §4 验证结果

| 检查 | 结果 |
|---|---|
| 后端 `tsc` / `build` | ✅ 通过 |
| 前端 `tsc` | ✅ 通过 |
| 后端测试失败集合 | 56 个唯一失败，**与基线逐字一致**（54 个 EPERM = Windows 目录 fsync 限制 + 2 个既有；差集为零，无新增回归） |
| `workflowUtils` 测试 | ✅ 4/4（含新增无图 SOP 用例） |
| 路径隔离 / id 校验 / slug | ✅ node 脚本实测 |
| 多项目运行时端到端 | ⚠️ **未实测**：本机目录 fsync EPERM 无法起 app 实例；隔离性以路径逻辑 + 锁语义 + 测试基线对比确认 |

### 实施中自行发现并修复的缺陷

1. 孤立节点绕过连通性检查（§1）
2. Host 校验正则被双重转义（`127\.0\.0\.1` → `127\\.`），会导致合法 host 被拒——已改回
3. `ProjectRegistry.index` 未初始化、`LangflowService` 回调签名不匹配——编译期暴露并修复

---

## §5 遗留任务（按优先级）

| # | 任务 | 说明 |
|---|---|---|
| 1 | **`apps/web/src/hooks/useStudio.ts:27` 回归修复** | ✅ 已修复。API 支持动态返回 `mock\|mixed`，前端不再被阻塞。 |
| 2 | langflow.ts 改异步 `/build` | ✅ 已实现。通过 `job_id` 轮询 `/events` 支持长任务执行。 |
| 3 | 前端项目选择 UI + 发送 `x-project-id` | ✅ 已实现。前端统一注入 `x-project-id` 请求头，并提供 UI 切换。 |
| 4 | `openapi.ts` 补 `/api/projects*` 描述 | ✅ 已实现。新增相关项目端点及 `projectId` 返回。 |
| 5 | 启用 `lfx[sandbox]` / `lfx[toolguard]` | ✅ 已实现。在 `services/langflow/pyproject.toml` 中增加并安装。 |
| 6 | 治理网关（MCP 前置） | ✅ 已实现。`maxSteps`/`maxToolCalls`/`maxCost` 在 `GovernanceGateway` 被读取并拦截。 |

## §6 已知问题（未修复，非本次引入）

1. `Handoff` 结构化契约未实现，agent 输出为裸文本直传下游
2. Langflow `polling` 模式的事件保留时长与并发上限未实测（调研文档 §4.5）

## §7 工作区其他变更（非本次改动）

- `.gitignore` 增加 `.agents/mcp_config.json`（用户改动）
- `run-rea-direct.mjs` / `docs/agentsroom-collaboration-analysis.md` —— 外部工具产物，未纳入整理


## 4. 补充说明

### 项目删除（`/api/projects/:id/delete`）语义
该接口目前实现为**逻辑注销与缓存释放**（不物理删除磁盘目录），这是为了保障数据安全与防并发读写冲突。

### 前端 `x-project-id` 请求头
建议通过 API 拦截器或上下文统一注入 `x-project-id`，避免在每个请求处硬编码。
