# AI Studio 当前架构图

> 基于工作区现状生成：`main @ 608f794` + 项目隔离 1–3 项改动（未提交）。
> 配套文档：`langflow-capability-research.md`（Langflow 调研）· `project-scoped-refactor-plan.md`（改造方案）· `implementation-notes.md`（实施记录）

## 1. 系统全景

```
┌──────────────────────── 浏览器 (localhost:5173) ────────────────────────┐
│  React + @xyflow/react(画布) + hash 视图路由                              │
│  x-project-id 请求头 → 决定操作哪个项目的数据                              │
└────────────────────────────┬────────────────────────────────────────────┘
                             ▼  fetch（Origin 白名单 + x-project-id）
┌──────────────── API 服务  Fastify 5  127.0.0.1:4000 ────────────────────┐
│  onRequest：x-project-id → StorePool.get(id) → request.project          │
│                                                                          │
│  ┌─ default 项目 → dataDir/                     （遗留布局，测试/旧数据） │
│  └─ 其他项目     → dataDir/projects/{id}/        （独立目录 + 独立锁）  │
└──────┬──────────────────┬───────────────────┬───────────────────────────┘
       ▼                  ▼                   ▼
  ProjectRegistry     Langflow :7860      外部模型服务
  (projects.json)     (异步 /build ⏳)    (OpenAI 兼容，凭据仅服务端 env)
```

## 2. 后端模块依赖

```
                     app.ts（路由 + 请求级项目绑定）
   ┌──────────┬───────────┬──────────────┬───────────┬──────────────┐
   ▼          ▼           ▼              ▼           ▼
StorePool  ProjectRegistry  langflow.ts  openapi.ts   agnesai.ts
(新)按项目  (新)跨项目注册表  (按项目实例)  ⏳缺项目端点  (只读目录探测)
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
  │     ⚠️ :27 仍硬性要求 health.mode === 'mock'（已知阻塞）
  ├─ 创作工作台   TemplatePicker · Workflow.tsx(节点图) · AssetGallery
  ├─ 工作流画布   WorkflowConfigPage.tsx ← @xyflow/react
  ├─ 配置中心     SettingsPage.tsx       ← provider/账号/model 三层
  ├─ 代理角色     RoleLibraryPage.tsx    ← 版本化角色草稿
  └─ Langflow     LangflowWorkspacePage.tsx

api.ts（唯一 HTTP 出口，⏳ 尚未发送 x-project-id）
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
| `Handoff` 结构化契约 | ⏳ 未实现（agent 输出为裸文本） |
| langflow.ts 使用 `/build` 异步事件流机制 | ✅ 已实现 |
| `openapi.ts` 补充 `/api/projects*` 描述及 `projectId` 返回 | ✅ 已实现 |
| 前端统一下发 `x-project-id` 请求头及 UI 切换支持 | ✅ 已实现 |
| 多项目运行时端到端验证（受限于 Windows 目录 fsync EPERM 报错） | ⚠️ 待验证（已知 Windows 限制） |
