# AI Studio 当前架构图

> 基于当前工作区现状生成（`main`，工作区改动未提交；评审更新于 2026-10-12）。
> 配套文档：`langflow-capability-research.md`（Langflow 调研）· `project-scoped-refactor-plan.md`（改造方案）· `implementation-notes.md`（实施记录）

架构图图片：[`architecture-map.svg`](./architecture-map.svg)

## 1. 系统全景（源码确认）

```mermaid
flowchart LR
  browser[浏览器\nReact + TypeScript\nHash 视图路由 / React Flow 画布]
  webapi[apps/web/src/api.ts\n唯一 HTTP 出口\n统一注入 x-project-id]
  fastify[apps/api\nFastify 5\n127.0.0.1:4000]
  guard[请求边界\nOrigin / Host / CORS\nZod 输入校验]
  registry[ProjectRegistry\nprojects.json\n项目生命周期与 revision]
  pool[StorePool\n按 projectId 缓存/并发去重]
  stores[项目级 StoreSet\nFile / Settings / Roles / Workflows\nAssets / Langflow / RunEngine]
  disk[(本地文件系统\ndefault: dataDir/\n其他项目: dataDir/projects/{id}/\n每目录 writer.lock)]
  engine[RunEngine\n项目内串行 drain\nrun 状态与恢复]
  mock[MockProvider\n本地 SVG 生成\nCODE_CONFIRMED / MOCK]
  gov[GovernanceGateway\n代理执行限制\nMCP attempt journal]
  agent[TextAgentRuntime\n服务端凭据\n单轮文本调用]
  model[OpenAI-compatible\n外部模型服务\nEXTERNAL_REQUIRED]
  lang[LangflowService\n异步 build + SSE events\n取消传播]
  langflow[Langflow 1.12.5\n127.0.0.1:7860\nCONFIG_CONFIRMED]
  mcp[MCP routes\n/api/mcp/execute\n/api/mcp/journal/:runId\n当前为 mock 执行]

  browser --> webapi -->|HTTP fetch| fastify
  fastify --> guard -->|x-project-id| pool
  fastify --> registry
  pool --> stores
  registry --> disk
  stores --> disk
  stores --> engine
  engine --> mock
  engine --> gov
  gov --> agent
  agent --> model
  stores --> lang
  lang -->|/api/v1/build/{flowId}/flow\n/events| langflow
  fastify --> mcp
  mcp --> gov

  classDef confirmed fill:#e8f5e9,stroke:#2e7d32,color:#1b1b1b;
  classDef mock fill:#fff8e1,stroke:#b7791f,color:#1b1b1b;
  classDef external fill:#fce8e6,stroke:#c62828,color:#1b1b1b;
  class browser,webapi,fastify,guard,registry,pool,stores,disk,engine,gov,lang,mcp confirmed;
  class mock mock;
  class model,langflow external;
```

图例：绿色为 `CODE_CONFIRMED`（源码/测试可确认）；黄色为已明确的本地 mock 行为；红色表示依赖外部服务或真实环境，当前仓库不能单独证明其可用性。

## 2. 后端模块依赖

```
                     app.ts（路由 + 请求级项目绑定）
   ┌──────────┬───────────┬──────────────┬───────────┬──────────────┐
   ▼          ▼           ▼              ▼           ▼
StorePool  ProjectRegistry  langflow.ts  openapi.ts   agent-runtime.ts
(新)按项目  (新)跨项目注册表  (按项目实例)  (项目端点已覆盖) (OpenAI-compatible 单轮文本)
   store 组  projects.json
   │
   ├─ FileStore        runs.json（单写者锁 per 目录 → 每项目独立锁）
   ├─ SettingsStore    settings.json（v2，只存 secretEnv 变量名）
   ├─ RoleStore        roles.json（7 内置角色 + 版本化草稿）
   ├─ WorkflowStore    workflows.json（版本化图 + 角色快照）
   ├─ AssetStore       assets/
   ├─ LangflowService  langflow-config.json + langflow-runs.json
   └─ RunEngine        每项目一个，串行 drain
        ├─ agent-runtime.ts ──► 外部模型服务（单轮文本）
        └─ provider.ts（mock SVG）

  横切：domain.ts（zod 契约）· provider.ts（ProviderOutcomeUnknownError）
        projects.ts（id 校验 / 目录解析 / slug）
```

**关键约束**

- 单写者锁：`writer.lock` 是 per-directory → 每个项目目录天然独立锁，锁逻辑零改动
- RunEngine 每项目一个实例：项目内串行；**多项目之间无并发控制**（共享 CPU/凭据）
- `createApp` 启动时 eager open default 项目（保留「启动即抢锁 + 快照校验」语义）
- agent-runtime.ts 凭据**只**从服务端 `process.env` 读，浏览器永不传密钥

## 3. 项目隔离 API（新增）

```
GET  /api/projects                        列表（含虚拟 default 项）
POST /api/projects                        创建（乐观锁 revision；立即初始化该项目的 store）
POST /api/projects/:id/sync-langflow      best-effort 同步到 Langflow（失败不阻塞）
POST /api/projects/:id/delete             删除（default 不可删；evict store 缓存）

其余全部数据端点（runs / workflows / roles / settings / assets / langflow）
    按 x-project-id 请求头路由到对应项目的 store 组；缺省 default。
```

## 4. 工作流校验（已放宽，解锁非媒体 SOP）

```
保留：CYCLE（无环）· ID 唯一 · 孤立节点检查
放宽：≥1 起始节点 + ≥1 终点节点（不限类型）
删除：IMAGE_REQUIRED · EXPORT_COUNT · ROOT_COUNT · EXPORT_IMAGE_PARENTS
新增：prompt → export 连线合法
保留：IMAGE_PROMPT_PARENT（image 节点自身属性，非赛道约束）

前端 apps/web/src/workflowUtils.ts 为平行校验副本，已同步上述规则。
```

## 5. 前端结构

```
App.tsx  (hash 视图切换 + 全局状态)
  ├─ useStudio.ts      ──► /api/health·templates·runs·assets   轮询
  │     支持 health.mode === 'mock' | 'mixed'
  ├─ 创作工作台   TemplatePicker · Workflow.tsx(节点图) · AssetGallery
  ├─ 工作流画布   WorkflowConfigPage.tsx ← @xyflow/react
  ├─ 配置中心     SettingsPage.tsx       ← provider/账号/model 三层
  ├─ 代理角色     RoleLibraryPage.tsx    ← 版本化角色草稿
  └─ Langflow     LangflowWorkspacePage.tsx

api.ts（唯一 HTTP 出口，统一注入 x-project-id）
types.ts（与后端 zod 契约手工镜像）
```

## 6. 数据落盘

```
dataDir/                    ← default 项目（遗留路径）
  runs.json · settings.json · roles.json · workflows.json
  langflow-config.json · langflow-runs.json · assets/ · writer.lock
  projects.json             ← 项目注册表（跨项目，含 revision 乐观锁）
  projects/
    {projectId}/            ← 其他项目，结构与上面完全相同
```

## 7. 与文档的落差 / 已知问题

| 项 | 状态 |
|---|---|
| `apps/web/src/hooks/useStudio.ts:27` 兼容 `mock\|mixed` 模式 | ✅ 已修复 |
| `maxSteps`/`maxToolCalls`/`maxCost` 治理拦截 | ✅ 已通过 Governance Gateway 实现 |
| `Handoff` 结构化契约 | ✅ 已实现；agent 输出生成并持久化 `handoffPackage`，下游支持 directive/summary/roleName 占位符 |
| langflow.ts 使用 `/build` 异步事件流机制 | ✅ 已实现 |
| `openapi.ts` 补充 `/api/projects*` 描述及 `projectId` 返回 | ✅ 已实现 |
| `openapi.ts` 补充 MCP 执行与 journal 契约 | ✅ 已实现；请求 schema 与路由共享 `mcp-contract.ts`，执行明确标注为 mock |
| 前端统一下发 `x-project-id` 请求头及 UI 切换支持 | ✅ 已实现 |
| 未注册/已删除项目访问边界 | ✅ API 回归覆盖，返回 `PROJECT_NOT_FOUND` |
| 同一项目并发首次初始化 | ✅ API 回归覆盖，打开 Promise 去重 |
| MCP journal 并发写入与完成状态 | ✅ API/治理回归覆盖，按项目目录串行落盘 |
| 多项目浏览器端到端 | ⚠️ 未覆盖；当前证据为 API 注入测试，Windows 目录 fsync 限制仍需独立环境验证 |
| 前后端类型契约共享 | ⚠️ `apps/web/src/types.ts` 与后端 Zod schema 仍为手工镜像；当前以 OpenAPI/API 回归测试约束，后续可评估共享 schema package |
